"""
Email notification subsystem for Jackery Monitor.

Persists settings encrypted at /data/notifications.json (AES-256-GCM via crypto_util).
Supports Gmail / standard SMTP with STARTTLS (port 587) or SSL (port 465), rich HTML
and plain-text emails, configurable alert triggers (low battery, cloud stall,
water leak, freeze warnings), and cooldown de-duplication to prevent inbox flooding.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import logging
import os
import smtplib
import ssl
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid
from typing import Any

import crypto_util

log = logging.getLogger("notifications")

PATH = os.environ.get("JACKERY_NOTIFICATIONS_FILE", "/data/notifications.json")

# In-memory timestamp tracker for alert keys to enforce cooldowns:
# alert_key -> last_sent_timestamp (epoch seconds)
_LAST_ALERT_TS: dict[str, float] = {}

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587,
    "use_tls": True,
    "username": "",
    "password": "",
    "recipient": "",
    "sender_name": "Jackery Monitor",
    "alert_on_low_battery": True,
    "alert_on_cloud_stall": True,
    "alert_on_water_leak": True,
    "alert_on_freeze": True,
    "alert_on_tank_full": True,
    "freeze_threshold_c": 5.0,
    "cooldown_minutes": 60,
}


def has_config() -> bool:
    """Check if notifications configuration file exists and is non-empty."""
    try:
        return os.path.getsize(PATH) > 0
    except OSError:
        return False


def load_config() -> dict[str, Any]:
    """
    Return full configuration dict including decrypted password.
    Falls back to defaults for any missing keys.
    """
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(PATH, encoding="utf-8") as f:
            blob = json.load(f)
    except FileNotFoundError:
        return cfg
    except Exception as e:
        log.warning("Notifications config file %s unreadable: %s", PATH, e)
        return cfg

    if not isinstance(blob, dict) or "ct" not in blob:
        return cfg

    pt = crypto_util.decrypt(blob)
    if pt is None:
        log.error("Failed to decrypt notifications config")
        return cfg

    try:
        data = json.loads(pt.decode("utf-8"))
        if isinstance(data, dict):
            cfg.update(data)
    except Exception as e:
        log.error("Invalid JSON in decrypted notifications config: %s", e)

    return cfg


def get_public_config() -> dict[str, Any]:
    """
    Return configuration safe for frontend consumption.
    The password is NEVER returned — only a boolean flag indicating if one is saved.
    """
    cfg = load_config()
    has_pwd = bool(cfg.get("password"))
    masked = dict(cfg)
    masked["password"] = "••••••••" if has_pwd else ""
    masked["has_password"] = has_pwd
    masked["is_configured"] = bool(cfg.get("username") and has_pwd and cfg.get("recipient"))
    return masked


def save_config(new_cfg: dict[str, Any]) -> bool:
    """
    Encrypt and save notification settings.
    If new_cfg['password'] is empty or masked ('••••••••'), keeps previously saved password.
    """
    existing = load_config()
    merged = dict(existing)
    merged.update(new_cfg)

    # Sanitize password: if unchanged/masked/blank, retain existing password
    new_pwd = str(new_cfg.get("password") or "").strip()
    if not new_pwd or new_pwd == "••••••••":
        merged["password"] = existing.get("password", "")
    else:
        merged["password"] = new_pwd

    # Normalize types
    merged["enabled"] = bool(merged.get("enabled", False))
    merged["smtp_port"] = int(merged.get("smtp_port") or 587)
    merged["use_tls"] = bool(merged.get("use_tls", True))
    merged["username"] = str(merged.get("username") or "").strip()
    merged["recipient"] = str(merged.get("recipient") or "").strip()
    merged["sender_name"] = str(merged.get("sender_name") or "Jackery Monitor").strip()
    merged["alert_on_low_battery"] = bool(merged.get("alert_on_low_battery", True))
    merged["alert_on_cloud_stall"] = bool(merged.get("alert_on_cloud_stall", True))
    merged["alert_on_water_leak"] = bool(merged.get("alert_on_water_leak", True))
    merged["alert_on_freeze"] = bool(merged.get("alert_on_freeze", True))
    merged["alert_on_tank_full"] = bool(merged.get("alert_on_tank_full", True))
    merged["freeze_threshold_c"] = float(merged.get("freeze_threshold_c", 5.0))
    merged["cooldown_minutes"] = max(1, int(merged.get("cooldown_minutes", 60)))

    try:
        payload = json.dumps(merged).encode("utf-8")
        blob = crypto_util.encrypt(payload)
        os.makedirs(os.path.dirname(PATH) or ".", exist_ok=True)
        tmp = PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(blob, f)
        try:
            os.chmod(tmp, 0o600)
        except Exception:
            pass
        os.replace(tmp, PATH)
        log.info("Saved notifications configuration (enabled=%s, host=%s)", merged["enabled"], merged["smtp_host"])
        return True
    except Exception as e:
        log.error("Failed to save notifications configuration: %s", e)
        return False


def clear_config() -> bool:
    """Remove notifications configuration file."""
    try:
        os.remove(PATH)
        return True
    except FileNotFoundError:
        return True
    except Exception as e:
        log.error("Failed to delete notifications config: %s", e)
        return False


def _build_html_email(
    title: str,
    level: str,
    details: dict[str, Any],
    message: str | None = None,
) -> str:
    """Build a modern, dark/light compatible responsive HTML email."""
    # Determine level color
    level_lower = (level or "info").lower()
    if level_lower in ("critical", "alarm", "error", "leak"):
        badge_bg = "#dc2626"
        badge_text = "#ffffff"
        header_border = "#ef4444"
        badge_label = "CRITICAL ALERT"
    elif level_lower in ("warning", "warn"):
        badge_bg = "#d97706"
        badge_text = "#ffffff"
        header_border = "#f59e0b"
        badge_label = "WARNING"
    else:
        badge_bg = "#2563eb"
        badge_text = "#ffffff"
        header_border = "#3b82f6"
        badge_label = "NOTIFICATION"

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # Render table rows
    rows_html = ""
    for k, v in details.items():
        if v is not None and v != "":
            rows_html += f"""
            <tr>
              <td style="padding: 9px 12px; font-weight: 600; color: #475569; border-bottom: 1px solid #e2e8f0; width: 35%; font-size: 13px;">{k}</td>
              <td style="padding: 9px 12px; color: #0f172a; border-bottom: 1px solid #e2e8f0; font-size: 13px; font-family: monospace;">{v}</td>
            </tr>
            """

    desc_block = ""
    if message:
        desc_block = f"""
        <div style="background-color: #f8fafc; border-left: 4px solid {header_border}; padding: 12px 16px; margin: 16px 0; border-radius: 4px; color: #334155; font-size: 14px; line-height: 1.5;">
          {message}
        </div>
        """

    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
</head>
<body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; color: #1e293b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.06); border-top: 5px solid {header_border};">
    <tr>
      <td style="padding: 24px 28px;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <td>
              <span style="display: inline-block; padding: 4px 10px; border-radius: 12px; background-color: {badge_bg}; color: {badge_text}; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;">{badge_label}</span>
              <h2 style="margin: 12px 0 6px 0; font-size: 20px; color: #0f172a; font-weight: 700;">{title}</h2>
              <span style="font-size: 12px; color: #64748b;">Triggered at: {now_str}</span>
            </td>
          </tr>
        </table>

        {desc_block}

        <div style="margin-top: 20px;">
          <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border: 1px solid #e2e8f0; border-radius: 6px; border-collapse: collapse;">
            {rows_html}
          </table>
        </div>

        <div style="margin-top: 28px; padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 12px;">
          Jackery Monitor • Real-Time Energy &amp; Home Automation Alerts
        </div>
      </td>
    </tr>
  </table>
</body>
</html>"""


def send_email_sync(
    cfg: dict[str, Any],
    recipient: str,
    subject: str,
    text_content: str,
    html_content: str | None = None,
) -> None:
    """
    Synchronous SMTP delivery helper using standard library smtplib.
    Raises smtplib/socket exceptions on connection/auth failure.
    """
    host = str(cfg.get("smtp_host") or "smtp.gmail.com").strip()
    port = int(cfg.get("smtp_port") or 587)
    use_tls = bool(cfg.get("use_tls", True))
    username = str(cfg.get("username") or "").strip()
    password = str(cfg.get("password") or "")
    sender_name = str(cfg.get("sender_name") or "Jackery Monitor").strip()

    if not username or not password:
        raise ValueError("SMTP username or password missing")
    if not recipient:
        raise ValueError("No recipient email specified")

    # Split multiple comma or semicolon separated recipients
    recipients = [r.strip() for r in recipient.replace(";", ",").split(",") if r.strip()]
    if not recipients:
        raise ValueError("Invalid recipient list")

    from_header = f"{sender_name} <{username}>" if sender_name else username

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_header
    msg["To"] = ", ".join(recipients)
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=host if "." in host else "local")

    # Plain-text part
    msg.attach(MIMEText(text_content, "plain", "utf-8"))

    # HTML part
    if html_content:
        msg.attach(MIMEText(html_content, "html", "utf-8"))

    # Send via SMTP_SSL (port 465) or SMTP with STARTTLS (port 587/25)
    if port == 465:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, context=context, timeout=20.0) as server:
            server.login(username, password)
            server.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=20.0) as server:
            server.ehlo()
            if use_tls:
                context = ssl.create_default_context()
                server.starttls(context=context)
                server.ehlo()
            server.login(username, password)
            server.send_message(msg)


async def send_email(
    cfg: dict[str, Any],
    recipient: str,
    subject: str,
    text_content: str,
    html_content: str | None = None,
) -> None:
    """Async wrapper for send_email_sync to keep event loop unblocked."""
    await asyncio.to_thread(
        send_email_sync,
        cfg,
        recipient,
        subject,
        text_content,
        html_content,
    )


async def send_test_email(
    override_cfg: dict[str, Any] | None = None,
    test_recipient: str | None = None,
) -> tuple[bool, str]:
    """
    Test SMTP connectivity and credentials by sending a test message.
    Returns (True, message) or (False, error_description).
    """
    cfg = dict(load_config())
    if override_cfg:
        # If user passed in unsaved form fields, merge them
        for k, v in override_cfg.items():
            if k == "password" and (not v or v == "••••••••"):
                continue
            cfg[k] = v

    recipient = (test_recipient or cfg.get("recipient") or cfg.get("username") or "").strip()
    if not recipient:
        return False, "Recipient email is required to send a test message."

    subject = "[Jackery Monitor] Test Notification"
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    text_body = (
        f"This is a test notification from Jackery Monitor.\n\n"
        f"SMTP Host: {cfg.get('smtp_host')}:{cfg.get('smtp_port')}\n"
        f"Sender: {cfg.get('username')}\n"
        f"Timestamp: {now_str}\n\n"
        f"Your notification settings are working properly!"
    )

    details = {
        "Status": "Verified ✅",
        "SMTP Server": f"{cfg.get('smtp_host')}:{cfg.get('smtp_port')}",
        "Sender Account": str(cfg.get("username")),
        "Test Recipient": recipient,
        "Timestamp": now_str,
    }
    html_body = _build_html_email(
        title="Test Notification Successful",
        level="info",
        details=details,
        message="Your Jackery Monitor email alerts are successfully configured and working!",
    )

    try:
        await send_email(cfg, recipient, subject, text_body, html_body)
        log.info("Successfully sent test email to %s", recipient)
        return True, f"Test email sent successfully to {recipient}!"
    except smtplib.SMTPAuthenticationError as e:
        err_msg = str(e.smtp_error.decode(errors="replace") if hasattr(e, "smtp_error") and isinstance(e.smtp_error, bytes) else e)
        log.warning("SMTP Authentication failed during test: %s", err_msg)
        return False, f"Authentication failed: Check your email and Google App Password ({err_msg})"
    except smtplib.SMTPConnectError as e:
        log.warning("SMTP Connection error during test: %s", e)
        return False, f"Could not connect to {cfg.get('smtp_host')}:{cfg.get('smtp_port')} ({e})"
    except Exception as e:
        log.warning("Failed to send test email: %s", e)
        return False, f"Failed to send email: {e}"


async def dispatch_alert(
    alert_key: str,
    alert_type: str,
    title: str,
    details: dict[str, Any],
    message: str | None = None,
    level: str = "warning",
) -> bool:
    """
    Dispatch an email alert if notifications are enabled, the alert type is active,
    and the cooldown period for alert_key has elapsed.
    """
    cfg = load_config()
    if not cfg.get("enabled", False):
        return False

    # Check alert type filter
    type_flag = f"alert_on_{alert_type}"
    if type_flag in cfg and not cfg.get(type_flag, True):
        log.debug("Alert %s suppressed by config %s=False", alert_key, type_flag)
        return False

    recipient = str(cfg.get("recipient") or "").strip()
    if not recipient or not cfg.get("username") or not cfg.get("password"):
        return False

    # Cooldown check
    now = time.time()
    cooldown_s = int(cfg.get("cooldown_minutes", 60)) * 60
    last_ts = _LAST_ALERT_TS.get(alert_key, 0.0)
    if now - last_ts < cooldown_s:
        log.info(
            "Alert '%s' suppressed: on cooldown (last sent %.0fs ago, cooldown %ds)",
            alert_key,
            now - last_ts,
            cooldown_s,
        )
        return False

    subject = f"[Jackery Monitor] {title}"
    text_lines = [f"=== {title} ===", ""]
    if message:
        text_lines.extend([message, ""])
    for k, v in details.items():
        if v is not None and v != "":
            text_lines.append(f"{k}: {v}")
    text_lines.extend(["", f"Timestamp: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}"])
    text_body = "\n".join(text_lines)

    html_body = _build_html_email(
        title=title,
        level=level,
        details=details,
        message=message,
    )

    try:
        await send_email(cfg, recipient, subject, text_body, html_body)
        _LAST_ALERT_TS[alert_key] = now
        log.info("Dispatched alert email '%s' to %s", title, recipient)
        return True
    except Exception as e:
        log.error("Failed to dispatch alert '%s' to %s: %s", alert_key, recipient, e)
        return False


def clear_alert_state(alert_key: str | None = None) -> None:
    """Reset alert cooldown timestamp(s) when conditions recover."""
    global _LAST_ALERT_TS
    if alert_key:
        _LAST_ALERT_TS.pop(alert_key, None)
    else:
        _LAST_ALERT_TS.clear()
