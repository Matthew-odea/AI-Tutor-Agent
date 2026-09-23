from __future__ import annotations

import json
import os
import re

import uuid
from pathlib import Path
from typing import List, Optional, Dict, Any

from neo4j import GraphDatabase, Driver

from src.main.utils.SplitByMd import split_by_markdown_heading
from src.main.service.TextPreprocessingService import TextPreprocessingService
from src.main.llm.AgentCoreProvider import AgentCoreProvider


class ContextVectorService:
    def __init__(
        self,
        neo4j_uri: str | None = None,
        neo4j_user: str | None = None,
        neo4j_password: str | None = None,
        aws_region: str | None = None,
        embed_model_id: str | None = None,
        expected_embed_dim: Optional[int] = None,
        embed_max_chars: Optional[int] = None,
    ) -> None:
        self.neo4j_uri = neo4j_uri or os.getenv("NEO4J_URI")
        self.neo4j_user = neo4j_user or os.getenv("NEO4J_USERNAME")
        self.neo4j_password = neo4j_password or os.getenv("NEO4J_PASSWORD")

        # aws_region/embed_model_id are only echoed in upload responses; embed() uses
        # AgentCoreProvider, which reads BEDROCK_MODEL_EMBED from agentcore_setup.config.
        self.aws_region = aws_region or os.getenv("AWS_REGION", "ap-southeast-2")
        self.embed_model_id = embed_model_id or os.getenv("EMBED_MODEL", "cohere.embed-english-v3")
        self.expected_embed_dim = expected_embed_dim or 1024
        # 2048 is the limit observed from the embed API's ValidationException
        self.embed_max_chars = embed_max_chars or int(os.getenv("EMBED_MAX_CHARS", "2048"))
        self.ingest_chunk_max_chars = int(os.getenv("CONTEXT_CHUNK_MAX_CHARS", "1800"))
        self.ingest_chunk_overlap_chars = int(os.getenv("CONTEXT_CHUNK_OVERLAP_CHARS", "220"))
        self.enable_llm_preprocessing = os.getenv("CONTEXT_ENABLE_LLM_PREPROCESSING", "false").lower() == "true"
        self._course_structure = self._load_course_structure()

        self.driver: Driver = GraphDatabase.driver(self.neo4j_uri, auth=(self.neo4j_user, self.neo4j_password))
        self.preprocessor = TextPreprocessingService()
        self.llm = AgentCoreProvider()

    @staticmethod
    def _load_course_structure() -> Dict[str, Any]:
        config_path = Path(__file__).resolve().parents[1] / "config" / "comp9021_structure.json"
        if not config_path.exists():
            return {}
        try:
            return json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    @staticmethod
    def _normalize_text_for_ingest(text: str) -> str:
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        normalized = re.sub(r"\n{4,}", "\n\n\n", normalized)
        return normalized.strip()

    @staticmethod
    def _infer_artifact_type(document_name: str, source_path: Optional[str], artifact_type: Optional[str]) -> str:
        if artifact_type and artifact_type.strip():
            return artifact_type.strip().lower()

        reference = (source_path or document_name or "").lower()
        _, ext = os.path.splitext(reference)
        mapping = {
            ".py": "code",
            ".ipynb": "notebook",
            ".md": "markdown",
            ".pdf": "pdf",
            ".txt": "text",
            ".tex": "text",
            ".csv": "text",
        }
        return mapping.get(ext, "text")

    @staticmethod
    def _extract_family_and_module(source_path: str | None) -> tuple[str, int | None]:
        if not source_path:
            return "unknown", None

        normalized = source_path.replace("\\", "/").lower()
        parts = [part for part in normalized.split("/") if part]
        top = parts[0] if parts else "unknown"

        family_map = {
            "lectures": "lecture",
            "labs": "lab",
            "quizzes": "quiz",
            "assignment 1": "assignment",
            "assignment 2": "assignment",
            "course overview": "course_overview",
        }
        family = family_map.get(top, top.replace(" ", "_"))

        module_number: int | None = None
        for part in parts:
            match = re.search(r"\b(?:lecture|lab|quiz|assignment)\s*(\d+)\b", part)
            if match:
                module_number = int(match.group(1))
                break

        return family, module_number

    def _resolve_learning_block(self, content_family: str, module_number: int | None) -> tuple[str, str]:
        if module_number is None:
            return "unmapped", "Unmapped"

        for block in self._course_structure.get("learning_blocks", []):
            match = block.get("match", {})
            family_range = match.get(content_family)
            if isinstance(family_range, list) and len(family_range) == 2:
                start, end = int(family_range[0]), int(family_range[1])
                if start <= module_number <= end:
                    return str(block.get("block_id", "unmapped")), str(block.get("label", "Unmapped"))

        return "unmapped", "Unmapped"

    @staticmethod
    def _derive_asset_role(source_path: str | None, document_name: str) -> str:
        reference = f"{source_path or ''} {document_name}".lower()
        if "template" in reference:
            return "template"
        if "test" in reference or "run_and_test" in reference:
            return "test"
        if "expected" in reference:
            return "expected_output"
        if "overview" in reference:
            return "overview"
        if "working" in reference:
            return "worked_example"
        return "primary"

    def _build_course_metadata(
        self,
        document_name: str,
        source_path: str | None,
        scope: str,
        course_code: str | None,
        course_term: str | None,
        course_year: int | None,
    ) -> Dict[str, Any]:
        structure = self._course_structure
        resolved_course_code = (course_code or structure.get("course_code") or "COMP9021").strip().upper()
        resolved_course_term = (course_term or structure.get("default_term") or "T3").strip().upper()
        resolved_course_year = int(course_year or structure.get("default_year") or 2025)

        content_family, module_number = self._extract_family_and_module(source_path)
        learning_block_id, learning_block_label = self._resolve_learning_block(content_family, module_number)
        asset_role = self._derive_asset_role(source_path, document_name)
        is_assessment = content_family in {"assignment", "quiz"}
        assessment_type = content_family if is_assessment else "none"

        return {
            "course_code": resolved_course_code,
            "course_term": resolved_course_term,
            "course_year": resolved_course_year,
            "content_family": content_family,
            "module_number": module_number,
            "module_label": f"{content_family}_{module_number}" if module_number is not None else content_family,
            "learning_block": learning_block_id,
            "learning_block_label": learning_block_label,
            "asset_role": asset_role,
            "is_assessment": is_assessment,
            "assessment_type": assessment_type,
            "scope": scope,
            "alignment_mode": structure.get("alignment_mode", "teaching_sequence_not_week"),
        }

    @staticmethod
    def _best_effort_title(chunk_text: str) -> str:
        first_line = next((line.strip() for line in chunk_text.splitlines() if line.strip()), "")
        if not first_line:
            return ""
        if len(first_line) <= 90:
            return first_line
        return f"{first_line[:87]}..."

    def _split_large_chunk(self, text: str) -> List[str]:
        if len(text) <= self.ingest_chunk_max_chars:
            return [text]

        chunks: List[str] = []
        start = 0
        text_len = len(text)

        while start < text_len:
            target_end = min(start + self.ingest_chunk_max_chars, text_len)
            if target_end < text_len:
                window = text[start:target_end]
                pivot = max(window.rfind("\n\n"), window.rfind("\n"))
                if pivot > int(self.ingest_chunk_max_chars * 0.55):
                    target_end = start + pivot

            chunk_text = text[start:target_end].strip()
            if chunk_text:
                chunks.append(chunk_text)

            if target_end >= text_len:
                break

            next_start = max(target_end - self.ingest_chunk_overlap_chars, start + 1)
            start = next_start

        return chunks

    def _build_ingestion_chunks(self, text: str, artifact_type: str) -> tuple[List[Dict[str, str]], str]:
        strategy = "size"
        candidate_sections: List[Dict[str, str]] = []

        if artifact_type == "markdown":
            markdown_sections = split_by_markdown_heading(text)
            if markdown_sections and len(markdown_sections) > 1:
                strategy = "markdown_heading"
                candidate_sections = markdown_sections

        if not candidate_sections and artifact_type in {"code", "notebook"}:
            boundaries = list(re.finditer(r"(?m)^(?:class\s+\w+|def\s+\w+|async\s+def\s+\w+)", text))
            if boundaries:
                strategy = "code_symbol"
                for idx, marker in enumerate(boundaries):
                    end = boundaries[idx + 1].start() if idx + 1 < len(boundaries) else len(text)
                    section_text = text[marker.start():end].strip()
                    if section_text:
                        candidate_sections.append({"title": self._best_effort_title(section_text), "content": section_text})

        if not candidate_sections:
            candidate_sections = [{"title": "", "content": text}]

        finalized: List[Dict[str, str]] = []
        for section in candidate_sections:
            section_title = (section.get("title") or "").strip()
            section_content = (section.get("content") or "").strip()
            if not section_content:
                continue

            split_parts = self._split_large_chunk(section_content)
            if len(split_parts) > 1 and strategy != "size":
                strategy = f"{strategy}+size"

            for part in split_parts:
                finalized.append({
                    "title": section_title or self._best_effort_title(part),
                    "content": part,
                })

        return finalized, strategy

    def embed(self, text: str) -> List[float]:
        if not isinstance(text, str):
            text = str(text)

        # Keep the start (truncate=END) to avoid the provider's ValidationException on long input
        if self.embed_max_chars and len(text) > self.embed_max_chars:
            print(f"[warn] input too long for embed API (len={len(text)}); truncating to {self.embed_max_chars} chars")
            text = text[: self.embed_max_chars]

        vectors = self.llm.embed([text])
        if isinstance(vectors, dict) and "vectors" in vectors:
            vectors = vectors["vectors"]
        if not vectors or not isinstance(vectors, list) or not isinstance(vectors[0], list):
            raise ValueError(f"Embedding response malformed: {vectors}")
        if len(vectors[0]) != self.expected_embed_dim:
            raise ValueError(f"Embedding dim mismatch: expected {self.expected_embed_dim}, got {len(vectors[0])}")
        return vectors[0]

    def upload_document(
        self,
        document_name: str,
        description: str,
        text: str,
        scope: str,
        artifact_type: str | None = None,
        source_path: str | None = None,
        course_code: str | None = None,
        course_term: str | None = None,
        course_year: int | None = None,
    ) -> Dict[str, Any]:
        """All chunks share one document_id and are keyed by (id, chunk_idx)."""
        normalized_text = self._normalize_text_for_ingest(text)
        if not normalized_text:
            raise ValueError("Cannot upload empty document text")

        resolved_artifact_type = self._infer_artifact_type(document_name, source_path, artifact_type)
        processed_text = normalized_text
        if self.enable_llm_preprocessing and resolved_artifact_type in {"markdown", "pdf", "text"}:
            try:
                processed_text = self.preprocessor.preprocess_to_markdown(normalized_text)
            except Exception:
                processed_text = normalized_text

        chunks, chunk_strategy = self._build_ingestion_chunks(processed_text, resolved_artifact_type)
        if not chunks:
            raise ValueError("No ingestible chunks were produced for document")

        document_id = uuid.uuid4().hex
        chunk_count = len(chunks)
        source_ref = (source_path or document_name).strip()
        course_metadata = self._build_course_metadata(
            document_name=document_name,
            source_path=source_ref,
            scope=scope,
            course_code=course_code,
            course_term=course_term,
            course_year=course_year,
        )

        inserted = []
        with self.driver.session() as s:
            for i, ch in enumerate(chunks):
                chunk_text = ch["content"] if isinstance(ch, dict) and "content" in ch else str(ch)
                chunk_title = ch["title"] if isinstance(ch, dict) and "title" in ch else ""
                embedding = self.embed(chunk_text)
                s.run(
                    """
                    MERGE (d:Document {id: $id, chunk_idx: $idx})
                    SET d.title = $title,
                        d.chunk_title = $chunk_title,
                        d.description = $description,
                        d.text = $text,
                        d.embedding = $embedding,
                        d.scope = $scope,
                        d.artifact_type = $artifact_type,
                        d.source_path = $source_path,
                        d.chunk_count = $chunk_count,
                        d.chunk_strategy = $chunk_strategy,
                        d.char_count = $char_count,
                        d.course_code = $course_code,
                        d.course_term = $course_term,
                        d.course_year = $course_year,
                        d.content_family = $content_family,
                        d.module_number = $module_number,
                        d.module_label = $module_label,
                        d.learning_block = $learning_block,
                        d.learning_block_label = $learning_block_label,
                        d.asset_role = $asset_role,
                        d.is_assessment = $is_assessment,
                        d.assessment_type = $assessment_type,
                        d.alignment_mode = $alignment_mode,
                        d.createdAt = datetime()
                    """,
                    id=document_id,
                    title=document_name,
                    chunk_title=chunk_title,
                    description=description,
                    text=chunk_text,
                    embedding=embedding,
                    idx=i,
                    scope=scope,
                    artifact_type=resolved_artifact_type,
                    source_path=source_ref,
                    chunk_count=chunk_count,
                    chunk_strategy=chunk_strategy,
                    char_count=len(chunk_text),
                    course_code=course_metadata["course_code"],
                    course_term=course_metadata["course_term"],
                    course_year=course_metadata["course_year"],
                    content_family=course_metadata["content_family"],
                    module_number=course_metadata["module_number"],
                    module_label=course_metadata["module_label"],
                    learning_block=course_metadata["learning_block"],
                    learning_block_label=course_metadata["learning_block_label"],
                    asset_role=course_metadata["asset_role"],
                    is_assessment=course_metadata["is_assessment"],
                    assessment_type=course_metadata["assessment_type"],
                    alignment_mode=course_metadata["alignment_mode"],
                )
                inserted.append({
                    "id": document_id,
                    "title": document_name,
                    "description": description,
                    "chunk_idx": i,
                    "scope": scope,
                    "artifact_type": resolved_artifact_type,
                    "source_path": source_ref,
                    "chunk_title": chunk_title,
                    "content_family": course_metadata["content_family"],
                    "module_number": course_metadata["module_number"],
                    "learning_block": course_metadata["learning_block"],
                    "asset_role": course_metadata["asset_role"],
                })

        return {
            "document_id": document_id,
            "title": document_name,
            "chunks": inserted,
            "embed_dim": self.expected_embed_dim,
            "embed_model": self.embed_model_id,
            "artifact_type": resolved_artifact_type,
            "chunk_strategy": chunk_strategy,
            "course_metadata": course_metadata,
        }

    def delete_document(self, document_id: str) -> Dict[str, int]:
        with self.driver.session() as s:
            rec = s.run(
                """
                MATCH (d:Document {id: $document_id})
                WITH collect(d) AS docs, count(d) AS doc_count
                FOREACH (x IN docs | DETACH DELETE x)
                RETURN doc_count AS documents_deleted
                """,
                document_id=document_id,
            ).single()

            if rec:
                return {"documents_deleted": rec["documents_deleted"]}
            else:
                return {"documents_deleted": 0}

    def list_documents(self, offset: int, limit: int, scope: str):
        query = (
            "MATCH (d:Document) "
            "WHERE d.scope = $scope "
            "WITH d ORDER BY d.createdAt DESC "
            "SKIP $offset LIMIT $limit "
            "RETURN d.id AS document_id, d.title AS title, d.description AS description, d.scope AS scope, d.createdAt AS created_at "
        )
        with self.driver.session() as s:
            result = s.run(query, scope=scope, offset=offset, limit=limit)
            docs = []
            for record in result:
                docs.append({
                    "document_id": record["document_id"],
                    "title": record["title"],
                    "description": record["description"],
                    "scope": record["scope"],
                    "created_at": record["created_at"],
                })
            return docs

    def semantic_search(self, query: str, top_k: int = 5, scope: str | None = None) -> list[dict]:
        """Brute force: loads every chunk (in scope) and ranks by cosine similarity in Python; no Neo4j vector index is used."""
        import math
        def cosine_similarity(a, b):
            dot = sum(x*y for x, y in zip(a, b))
            norm_a = math.sqrt(sum(x*x for x in a))
            norm_b = math.sqrt(sum(y*y for y in b))
            if norm_a == 0 or norm_b == 0:
                return 0.0
            return dot / (norm_a * norm_b)

        query_embedding = self.embed(query)
        with self.driver.session() as s:
            if scope:
                results = s.run(
                    """
                    MATCH (d:Document)
                    WHERE d.scope = $scope
                    RETURN d.id AS id,
                           d.text AS text,
                           d.embedding AS embedding,
                           d.scope AS scope,
                           d.title AS title,
                           d.chunk_title AS chunk_title,
                           d.source_path AS source_path,
                           d.artifact_type AS artifact_type,
                           d.course_code AS course_code,
                           d.course_term AS course_term,
                           d.course_year AS course_year
                    """,
                    scope=scope,
                )
            else:
                results = s.run(
                    """
                    MATCH (d:Document)
                    RETURN d.id AS id,
                           d.text AS text,
                           d.embedding AS embedding,
                           d.scope AS scope,
                           d.title AS title,
                           d.chunk_title AS chunk_title,
                           d.source_path AS source_path,
                           d.artifact_type AS artifact_type,
                           d.course_code AS course_code,
                           d.course_term AS course_term,
                           d.course_year AS course_year
                    """
                )
            scored = []
            for r in results:
                emb = r["embedding"]
                if not emb or len(emb) != len(query_embedding):
                    continue  # missing or different-dimension embedding (e.g. from an older model)
                score = cosine_similarity(query_embedding, emb)
                scored.append({
                    "id": r["id"],
                    "text": r["text"],
                    "score": score,
                    "scope": r["scope"],
                    "title": r.get("title"),
                    "chunk_title": r.get("chunk_title"),
                    "source_path": r.get("source_path"),
                    "artifact_type": r.get("artifact_type"),
                    "course_code": r.get("course_code"),
                    "course_term": r.get("course_term"),
                    "course_year": r.get("course_year"),
                })
            scored.sort(key=lambda x: x["score"], reverse=True)
            return scored[:top_k]

    def close(self) -> None:
        self.driver.close()
