"""Unit tests for DeepgramTranscribeService with mocked HTTP."""
from __future__ import annotations

import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from src.main.service.SpeechToTextService import DeepgramTranscribeService


@pytest.fixture()
def api_key(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_SECRET_KEY", "test-key-123")
    return "test-key-123"


@pytest.fixture()
def audio_file():
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(b"fake audio data")
        path = f.name
    yield path
    os.unlink(path)


def _make_deepgram_response(transcript: str) -> dict:
    """Build a standard Deepgram API response."""
    return {
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {"transcript": transcript}
                    ]
                }
            ]
        }
    }


class TestInit:
    def test_init_with_env_key(self, api_key):
        svc = DeepgramTranscribeService()
        assert svc.api_key == "test-key-123"

    def test_init_with_explicit_key(self):
        svc = DeepgramTranscribeService(api_key="explicit-key")
        assert svc.api_key == "explicit-key"

    def test_init_without_key_raises(self, monkeypatch):
        monkeypatch.delenv("DEEPGRAM_SECRET_KEY", raising=False)
        with pytest.raises(EnvironmentError, match="DEEPGRAM_SECRET_KEY"):
            DeepgramTranscribeService()


class TestTranscribe:
    @patch("src.main.service.SpeechToTextService.requests.post")
    def test_successful_transcription(self, mock_post, api_key, audio_file):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = _make_deepgram_response("Hello world")
        mock_post.return_value = mock_resp

        svc = DeepgramTranscribeService()
        result = svc.transcribe(audio_file)

        assert result == "Hello world"
        mock_post.assert_called_once()

        # Verify auth header
        call_kwargs = mock_post.call_args
        assert "Token test-key-123" in call_kwargs.kwargs.get("headers", {}).get("Authorization", "")

    @patch("src.main.service.SpeechToTextService.requests.post")
    def test_transcription_with_language(self, mock_post, api_key, audio_file):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = _make_deepgram_response("Bonjour")
        mock_post.return_value = mock_resp

        svc = DeepgramTranscribeService()
        result = svc.transcribe(audio_file, language="fr")

        assert result == "Bonjour"
        call_kwargs = mock_post.call_args
        assert call_kwargs.kwargs.get("params", {}).get("language") == "fr"

    def test_file_not_found_raises(self, api_key):
        svc = DeepgramTranscribeService()
        with pytest.raises(FileNotFoundError):
            svc.transcribe("/nonexistent/path.wav")

    @patch("src.main.service.SpeechToTextService.requests.post")
    def test_http_error_raises(self, mock_post, api_key, audio_file):
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = Exception("HTTP 500")
        mock_post.return_value = mock_resp

        svc = DeepgramTranscribeService()
        with pytest.raises(Exception, match="Deepgram request failed"):
            svc.transcribe(audio_file)

    @patch("src.main.service.SpeechToTextService.requests.post")
    def test_empty_transcript_returns_empty_string(self, mock_post, api_key, audio_file):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = _make_deepgram_response("")
        mock_post.return_value = mock_resp

        svc = DeepgramTranscribeService()
        result = svc.transcribe(audio_file)
        assert result == ""

    @patch("src.main.service.SpeechToTextService.requests.post")
    def test_non_json_response_returns_text(self, mock_post, api_key, audio_file):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.side_effect = ValueError("Not JSON")
        mock_resp.text = "raw text response"
        mock_post.return_value = mock_resp

        svc = DeepgramTranscribeService()
        result = svc.transcribe(audio_file)
        assert result == "raw text response"


def _make_deepgram_response_with_confidence(transcript: str, confidence: float) -> dict:
    return {
        "results": {
            "channels": [
                {"alternatives": [{"transcript": transcript, "confidence": confidence}]}
            ]
        }
    }


class TestTranscribeWithMetadata:
    @patch("src.main.service.SpeechToTextService.requests.post")
    def test_returns_transcript_and_confidence(self, mock_post, api_key, audio_file):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = _make_deepgram_response_with_confidence("hello world", 0.97)
        mock_post.return_value = mock_resp

        result = DeepgramTranscribeService().transcribe_with_metadata(audio_file)
        assert result["transcript"] == "hello world"
        assert result["confidence"] == 0.97

    @patch("src.main.service.SpeechToTextService.requests.post")
    def test_confidence_none_when_absent(self, mock_post, api_key, audio_file):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = _make_deepgram_response("hello")  # no confidence key
        mock_post.return_value = mock_resp

        result = DeepgramTranscribeService().transcribe_with_metadata(audio_file)
        assert result["transcript"] == "hello"
        assert result["confidence"] is None

    @patch("src.main.service.SpeechToTextService.requests.post")
    def test_non_json_returns_text_with_none_confidence(self, mock_post, api_key, audio_file):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.side_effect = ValueError("Not JSON")
        mock_resp.text = "raw text"
        mock_post.return_value = mock_resp

        result = DeepgramTranscribeService().transcribe_with_metadata(audio_file)
        assert result == {"transcript": "raw text", "confidence": None}
