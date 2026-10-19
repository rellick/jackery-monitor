import os
import smtplib
import tempfile
from unittest.mock import MagicMock, patch
import pytest

import crypto_util
import notifications


@pytest.fixture(autouse=True)
def temp_notifications_storage(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        kp = os.path.join(td, ".key")
        np = os.path.join(td, "notifications.json")
        monkeypatch.setattr(crypto_util, "KEY_PATH", kp)
        monkeypatch.setattr(notifications, "PATH", np)
        notifications.clear_alert_state()
        yield


def test_notifications_config_lifecycle():
    assert not notifications.has_config()
    cfg = notifications.load_config()
    assert cfg["enabled"] is False
    assert cfg["smtp_host"] == "smtp.gmail.com"

    # Save initial config
    ok = notifications.save_config({
        "enabled": True,
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
        "username": "sender@gmail.com",
        "password": "secret-app-password",
        "recipient": "alerts@gmail.com",
        "alert_on_low_battery": True,
        "cooldown_minutes": 30,
    })
    assert ok is True
    assert notifications.has_config()

    loaded = notifications.load_config()
    assert loaded["enabled"] is True
    assert loaded["username"] == "sender@gmail.com"
    assert loaded["password"] == "secret-app-password"
    assert loaded["cooldown_minutes"] == 30

    # Public config hides password
    pub = notifications.get_public_config()
    assert pub["password"] == "••••••••"
    assert pub["has_password"] is True
    assert pub["is_configured"] is True

    # Save update without changing password
    notifications.save_config({
        "enabled": True,
        "username": "sender@gmail.com",
        "password": "••••••••",
        "cooldown_minutes": 45,
    })
    loaded2 = notifications.load_config()
    assert loaded2["password"] == "secret-app-password"
    assert loaded2["cooldown_minutes"] == 45

    # Clear
    assert notifications.clear_config() is True
    assert not notifications.has_config()
    assert notifications.load_config()["password"] == ""


def test_send_email_sync_smtp_tls():
    with patch("smtplib.SMTP") as mock_smtp_cls:
        mock_server = MagicMock()
        mock_smtp_cls.return_value.__enter__.return_value = mock_server

        cfg = {
            "smtp_host": "smtp.gmail.com",
            "smtp_port": 587,
            "use_tls": True,
            "username": "sender@gmail.com",
            "password": "password123",
            "sender_name": "Jackery Alert",
        }

        notifications.send_email_sync(
            cfg,
            recipient="recv1@gmail.com, recv2@gmail.com",
            subject="Test Subject",
            text_content="Hello text",
            html_content="<p>Hello html</p>",
        )

        mock_smtp_cls.assert_called_once_with("smtp.gmail.com", 587, timeout=20.0)
        mock_server.starttls.assert_called_once()
        mock_server.login.assert_called_once_with("sender@gmail.com", "password123")
        mock_server.send_message.assert_called_once()


def test_send_email_sync_smtp_ssl():
    with patch("smtplib.SMTP_SSL") as mock_ssl_cls:
        mock_server = MagicMock()
        mock_ssl_cls.return_value.__enter__.return_value = mock_server

        cfg = {
            "smtp_host": "smtp.gmail.com",
            "smtp_port": 465,
            "use_tls": True,
            "username": "sender@gmail.com",
            "password": "password123",
            "sender_name": "Jackery Alert",
        }

        notifications.send_email_sync(
            cfg,
            recipient="recv@gmail.com",
            subject="SSL Subject",
            text_content="SSL text",
        )

        mock_ssl_cls.assert_called_once()
        mock_server.login.assert_called_once_with("sender@gmail.com", "password123")
        mock_server.send_message.assert_called_once()


@pytest.mark.asyncio
async def test_send_test_email_success():
    notifications.save_config({
        "enabled": True,
        "username": "user@gmail.com",
        "password": "app-pwd-123",
        "recipient": "user@gmail.com",
    })

    with patch("notifications.send_email", return_value=None) as mock_send:
        ok, msg = await notifications.send_test_email()
        assert ok is True
        assert "successfully" in msg
        mock_send.assert_called_once()


@pytest.mark.asyncio
async def test_send_test_email_auth_failure():
    notifications.save_config({
        "enabled": True,
        "username": "user@gmail.com",
        "password": "wrong-pwd",
        "recipient": "user@gmail.com",
    })

    with patch("notifications.send_email", side_effect=smtplib.SMTPAuthenticationError(535, b"Invalid credentials")):
        ok, msg = await notifications.send_test_email()
        assert ok is False
        assert "Authentication failed" in msg


@pytest.mark.asyncio
async def test_dispatch_alert_cooldown_and_filters():
    notifications.save_config({
        "enabled": True,
        "username": "user@gmail.com",
        "password": "app-pwd-123",
        "recipient": "user@gmail.com",
        "alert_on_low_battery": True,
        "alert_on_cloud_stall": False,
        "cooldown_minutes": 60,
    })

    with patch("notifications.send_email", return_value=None) as mock_send:
        # 1. Low battery alert should dispatch
        dispatched = await notifications.dispatch_alert(
            alert_key="low_battery_sn123",
            alert_type="low_battery",
            title="Battery Low: 10%",
            details={"Battery": "10%", "Device": "Jackery 1000"},
            level="critical",
        )
        assert dispatched is True
        assert mock_send.call_count == 1

        # 2. Immediate duplicate low battery alert should be suppressed by cooldown
        dispatched_dup = await notifications.dispatch_alert(
            alert_key="low_battery_sn123",
            alert_type="low_battery",
            title="Battery Low: 9%",
            details={"Battery": "9%"},
            level="critical",
        )
        assert dispatched_dup is False
        assert mock_send.call_count == 1

        # 3. Cloud stall alert is configured False -> suppressed
        dispatched_stall = await notifications.dispatch_alert(
            alert_key="cloud_stall",
            alert_type="cloud_stall",
            title="Cloud Stalled",
            details={},
        )
        assert dispatched_stall is False
        assert mock_send.call_count == 1

        # 4. Clear alert state -> can fire again
        notifications.clear_alert_state("low_battery_sn123")
        dispatched_again = await notifications.dispatch_alert(
            alert_key="low_battery_sn123",
            alert_type="low_battery",
            title="Battery Low: 8%",
            details={"Battery": "8%"},
            level="critical",
        )
        assert dispatched_again is True
        assert mock_send.call_count == 2
