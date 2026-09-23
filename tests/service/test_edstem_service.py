import json

import pytest

from src.main.service import EdStemService as edstem_module
from src.main.service.EdStemService import EdStemService


class FakeEdWorkspace:
    """Stands in for websocket.WebSocketApp, replaying Ed's workspace protocol.

    Replies to list_folder with a listing and to each file_open with a file_ot_init carrying only
    a fid (no path), like the real server. Replies are queued and delivered from run_forever,
    not re-entrantly from send().
    """

    files: dict = {}

    def __init__(self, url, on_message=None, on_error=None):
        self.on_message = on_message
        self.opened = []
        self.inbox = [{"type": "client_join"}]
        self.closed = False

    def send(self, raw):
        msg = json.loads(raw)
        if msg.get("type") == "fsop" and msg["data"]["type"] == "list_folder":
            listing = [{"name": n} for n in self.files] + [{"name": "notes.txt"}]
            self.inbox.append({"type": "list_reply", "data": {"listing": listing}})
        elif msg.get("type") == "file_open":
            path = msg["data"]["path"]
            self.opened.append(path)
            self.inbox.append({"type": "file_ot_init", "data": {"fid": len(self.opened), "buffer": self.files[path]}})

    def run_forever(self, **_kwargs):
        while self.inbox and not self.closed:
            self.on_message(self, json.dumps(self.inbox.pop(0)))

    def close(self):
        self.closed = True


@pytest.fixture
def fake_ws(monkeypatch):
    instances = []

    def factory(*args, **kwargs):
        inst = FakeEdWorkspace(*args, **kwargs)
        instances.append(inst)
        return inst

    monkeypatch.setattr(edstem_module.websocket, "WebSocketApp", factory)
    monkeypatch.setattr(edstem_module, "WS_TIMEOUT", 2)
    return instances


def test_empty_file_in_middle_keeps_filenames_aligned_and_reads_all_files(fake_ws):
    FakeEdWorkspace.files = {
        "a.py": "print('a')\n",
        "empty.py": "",
        "b.py": "print('b')\n",
        "c.py": "print('c')\n",
    }

    code = EdStemService("token")._fetch_code_via_ws("ticket")

    assert fake_ws[0].opened == ["a.py", "empty.py", "b.py", "c.py"]
    assert code == (
        "# === a.py ===\nprint('a')\n\n\n"
        "# === b.py ===\nprint('b')\n\n\n"
        "# === c.py ===\nprint('c')\n"
    )
    assert "empty.py ===" not in code


def test_empty_first_file_does_not_stall(fake_ws):
    FakeEdWorkspace.files = {"empty.py": "   \n", "main.py": "x = 1\n"}

    code = EdStemService("token")._fetch_code_via_ws("ticket")

    assert fake_ws[0].opened == ["empty.py", "main.py"]
    assert code == "# === main.py ===\nx = 1\n"
