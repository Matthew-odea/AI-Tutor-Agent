"""Deepgram speech-to-text for local audio files."""
from typing import Optional
import os
import json
import requests


class DeepgramTranscribeService:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://api.deepgram.com/v1/listen",
        model: str = "general",
        timeout: int = 120,
    ):
        self.api_key = api_key or os.getenv("DEEPGRAM_SECRET_KEY")
        if not self.api_key:
            raise EnvironmentError("DEEPGRAM_SECRET_KEY not found in environment and no api_key provided")
        self.base_url = base_url
        self.model = model
        self.timeout = timeout

    def transcribe(self, audio_path: str, language: Optional[str] = None) -> str:
        """language is an optional BCP-47 code (e.g. "en-US")."""
        return self.transcribe_with_metadata(audio_path, language=language)["transcript"]

    def transcribe_with_metadata(self, audio_path: str, language: Optional[str] = None) -> dict:
        """Return {"transcript", "confidence"}; confidence is None when Deepgram doesn't report one."""
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        params = {"model": self.model}
        if language:
            params["language"] = language

        headers = {
            "Authorization": f"Token {self.api_key}",
            # Deepgram sniffs the audio format itself, so raw bytes as octet-stream is fine.
            "Content-Type": "application/octet-stream",
        }

        try:
            with open(audio_path, "rb") as f:
                resp = requests.post(self.base_url, params=params, headers=headers, data=f, timeout=self.timeout)
                resp.raise_for_status()
        except Exception as e:
            raise Exception(f"Deepgram request failed: {e}") from e

        try:
            data = resp.json()
        except ValueError:
            return {"transcript": resp.text or "", "confidence": None}

        return self._parse_response(data)

    @staticmethod
    def _parse_response(data: dict) -> dict:
        # Usual shape: results.channels[0].alternatives[0].{transcript, confidence}
        try:
            results = data.get("results", {})
            channels = results.get("channels", [])
            if channels and isinstance(channels, list):
                alts = channels[0].get("alternatives", [])
                if alts and isinstance(alts, list):
                    alt = alts[0]
                    transcript = alt.get("transcript", "") or ""
                    raw_conf = alt.get("confidence")
                    confidence = float(raw_conf) if isinstance(raw_conf, (int, float)) else None
                    return {"transcript": transcript, "confidence": confidence}

            # Some configs return results.transcripts[0].transcript instead.
            transcripts = results.get("transcripts", [])
            if transcripts and isinstance(transcripts, list):
                return {"transcript": transcripts[0].get("transcript", "") or "", "confidence": None}

            return {"transcript": json.dumps(data), "confidence": None}
        except Exception as e:
            raise Exception(f"Failed to parse Deepgram response: {e}") from e

