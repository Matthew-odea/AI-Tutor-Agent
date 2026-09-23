import re
from typing import List, Dict


def split_by_markdown_heading(text: str) -> List[Dict[str, str]]:
    """Split on '##' headings only into [{'title', 'content'}]; '#' and '###' are not split points. Text before the first heading is dropped."""
    heading_iter = list(re.finditer(r"(?m)^##\s+(.+)$", text))
    if not heading_iter:
        return [{"title": "", "content": text.strip()}] if text.strip() else []

    sections: List[Dict[str, str]] = []
    for i, m in enumerate(heading_iter):
        title = m.group(1).strip()
        start = m.end()
        end = heading_iter[i + 1].start() if i + 1 < len(heading_iter) else len(text)
        content = text[start:end].strip()
        sections.append({"title": title, "content": content})
    return sections
