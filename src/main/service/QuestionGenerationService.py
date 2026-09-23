"""Generates per-student oral exam questions from an assignment brief and the student's code.

Writes JSON/CSV copies to output_dir and, when student/assessment ids are given, the QUESTION# items to DynamoDB.
"""
import json
import csv
import logging
import os
import re
import uuid
import boto3
from boto3.dynamodb.conditions import Key
from pathlib import Path
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
from decimal import Decimal

from src.main.llm.AgentCoreProvider import AgentCoreProvider
from src.main.utils.ReadPrompt import read_prompt

logger = logging.getLogger(__name__)


class QuestionGenerationError(Exception):
    pass


class QuestionGenerationService:
    def __init__(
        self,
        agent_client: Optional[AgentCoreProvider] = None,
        output_dir: str = "test_outputs/questions"
    ):
        self.agent_client = agent_client or AgentCoreProvider()
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self.table_name = os.getenv('DYNAMODB_ASSESSMENT_TABLE', 'oral_assessments')
        self.region = os.getenv('AWS_REGION', 'us-east-1')
        self.dynamodb = boto3.resource('dynamodb', region_name=self.region)
        self.table = self.dynamodb.Table(self.table_name)
        
        prompt_file = Path(__file__).resolve().parents[3] / "prompts" / "question_generation_prompt.md"
        self.prompt_template = read_prompt(prompt_file)

    @staticmethod
    def _derive_course_level(course_code: str) -> str:
        """First digit of the code: <=1 introductory, 2 intermediate, 3+ advanced; no digit -> introductory."""
        match = re.search(r"\d", course_code or "")
        if not match:
            return "introductory"
        first_digit = int(match.group())
        if first_digit <= 1:
            return "introductory"
        if first_digit == 2:
            return "intermediate"
        return "advanced"

    def generate_questions(
        self,
        assignment_brief: str,
        student_code: str,
        student_name: str,
        student_id: Optional[str] = None,
        assessment_id: Optional[str] = None,
        assessment_time_limit: Optional[int] = None,
        course_name: Optional[str] = None,
        assessment_title: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Questions are stored in DynamoDB only when both student_id and assessment_id are given.

        student_name is used for output filenames; course_name is a course code (e.g. "COMP9021")
        used to pitch difficulty; assessment_time_limit is in minutes. A DynamoDB write failure is
        logged and reported via dynamodb_stored, not raised.
        """
        # Idempotent per student: questions are stored under fresh uuids, so a
        # redelivered message or a repeated batch would otherwise append a second
        # full set for a student who already has one (and may be answering it).
        if student_id and assessment_id and self._has_stored_questions(student_id, assessment_id):
            logger.info(
                "Student %s already has questions for assessment %s — not generating again",
                student_id, assessment_id,
            )
            return {
                "questions": [],
                "json_file_path": None,
                "csv_file_path": None,
                "questions_count": 0,
                "tokens_used": None,
                "dynamodb_stored": False,
                "skipped_existing": True,
            }

        print(f"[QuestionGenerationService] Generating questions for student: {student_name}")
        
        system_prompt = self._build_system_prompt()
        user_prompt = self._build_user_prompt(
            assignment_brief, student_code,
            course_name=course_name, assessment_title=assessment_title,
        )
        
        messages = [
            {
                "role": "user",
                "content": [
                    {"text": system_prompt},
                    {"text": user_prompt}
                ]
            }
        ]
        
        try:
            result = self.agent_client.chat(messages)
        except Exception as e:
            raise QuestionGenerationError(f"LLM call failed: {e}")
        
        if isinstance(result, dict):
            response_text = result.get("text") or result.get("content") or result.get("answer") or ""
            tokens_used = result.get("tokens_input")
        else:
            response_text = str(result)
            tokens_used = None
        
        questions = self._parse_json_response(response_text)

        # Retry the LLM once if nothing valid survives validation.
        questions = self._validate_questions(questions)
        if not questions:
            logger.warning("Validation failed on first attempt, retrying LLM call once.")
            try:
                result = self.agent_client.chat(messages)
            except Exception as e:
                raise QuestionGenerationError(f"LLM retry call failed: {e}")
            if isinstance(result, dict):
                response_text = result.get("text") or result.get("content") or result.get("answer") or ""
                tokens_used = result.get("tokens_input")
            else:
                response_text = str(result)
            questions = self._parse_json_response(response_text)
            questions = self._validate_questions(questions)
            if not questions:
                raise QuestionGenerationError("LLM produced no valid questions after retry.")

        json_path = self._save_json(questions, student_name)
        csv_path = self._save_csv(questions, student_name)
        
        dynamodb_stored = False
        if student_id and assessment_id:
            # Raised, not swallowed: the SQS consumer counts a return as success,
            # which left the student with no questions and nothing to retry.
            try:
                self._store_questions_in_dynamodb(
                    questions, student_id, assessment_id, student_code, assessment_time_limit
                )
            except Exception as e:
                raise QuestionGenerationError(f"Failed to store questions in DynamoDB: {e}") from e
            dynamodb_stored = True
            print(f"[QuestionGenerationService] Stored questions in DynamoDB for student {student_id}")
        
        print(f"[QuestionGenerationService] Generated {len(questions)} questions")
        print(f"[QuestionGenerationService] Saved to: {json_path} and {csv_path}")
        
        return {
            "questions": questions,
            "json_file_path": str(json_path),
            "csv_file_path": str(csv_path),
            "questions_count": len(questions),
            "tokens_used": tokens_used,
            "dynamodb_stored": dynamodb_stored
        }

    def _build_system_prompt(self) -> str:
        json_schema = """
You must respond with ONLY a valid JSON array. Each question object must have these exact fields:
{
  "question_number": <integer>,
  "question_type": "specific" or "general",
  "question": "<the question text>",
  "rationale": "<why this question tests important concepts>",
  "code_reference": "<the relevant code block (5-15 lines including surrounding context) being examined, or empty string for general questions>",
  "difficulty": "easy" | "medium" | "hard",
  "topic": "<short topic label, e.g. loops, functions, data_structures, recursion, error_handling>"
}

The "difficulty" and "topic" fields are optional but strongly encouraged.

Output format example:
[
  {
    "question_number": 1,
    "question_type": "specific",
    "question": "Can you explain how your for loop iterates through the list and why you chose this approach?",
    "rationale": "Tests understanding of loop mechanics and list iteration",
    "code_reference": "def process_items(my_list):\n    results = []\n    for item in my_list:\n        if item > 0:\n            results.append(item * 2)\n    return results",
    "difficulty": "easy",
    "topic": "loops"
  },
  {
    "question_number": 6,
    "question_type": "general",
    "question": "What is the difference between a list and a tuple in Python?",
    "rationale": "Tests fundamental understanding of data structures",
    "code_reference": "",
    "difficulty": "medium",
    "topic": "data_structures"
  }
]

Remember:
- Generate exactly 5 SPECIFIC questions (about the student's code)
- Generate exactly 3 GENERAL questions (about programming concepts)
- Number them 1-8 sequentially
- Return ONLY the JSON array, no other text
"""
        return self.prompt_template + "\n\n" + json_schema

    def _build_user_prompt(
        self,
        assignment_brief: str,
        student_code: str,
        course_name: Optional[str] = None,
        assessment_title: Optional[str] = None,
    ) -> str:
        brief = assignment_brief.strip() if assignment_brief else ""
        brief_section = brief

        if not brief or brief.lower() == "no assignment brief provided":
            logger.warning("No assignment brief provided; questions will be based solely on the code.")
            brief_section = (
                "No assignment brief provided. Generate questions based solely on the student's code, "
                "focusing on implementation details, logic, and programming concepts visible in the submission."
            )

        # Course context lets the LLM calibrate difficulty to the academic level.
        context_header = ""
        if course_name:
            course_level = self._derive_course_level(course_name)
            context_header = (
                f"**COURSE CONTEXT:**\n"
                f"Course: {course_name}\n"
                f"Assessment: {assessment_title or 'N/A'}\n\n"
                f"This is an {course_level} course. "
                f"Ensure all questions are appropriate for students at this level.\n\n---\n\n"
            )

        return f"""
{context_header}**ASSIGNMENT BRIEF:**
{brief_section}

---

**STUDENT SUBMISSION:**
```python
{student_code}
```

---

Generate the questions in JSON format as specified.
"""

    def _parse_json_response(self, response_text: str) -> List[Dict[str, Any]]:
        """Parse the JSON array from the LLM response, unwrapping a markdown code fence if present."""
        if "```json" in response_text:
            start = response_text.find("```json") + 7
            end = response_text.find("```", start)
            json_str = response_text[start:end].strip()
        elif "```" in response_text:
            start = response_text.find("```") + 3
            end = response_text.find("```", start)
            json_str = response_text[start:end].strip()
        else:
            json_str = response_text.strip()
        
        try:
            questions = json.loads(json_str)
        except json.JSONDecodeError as e:
            raise QuestionGenerationError(f"Failed to parse JSON response: {e}\nResponse: {response_text[:500]}")
        
        if not isinstance(questions, list):
            raise QuestionGenerationError(f"Expected JSON array, got: {type(questions)}")
        
        return questions

    def _save_json(self, questions: List[Dict[str, Any]], student_name: str) -> Path:
        filename = f"{student_name}_questions.json"
        filepath = self.output_dir / filename
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(questions, f, indent=2, ensure_ascii=False)
        
        return filepath

    def _save_csv(self, questions: List[Dict[str, Any]], student_name: str) -> Path:
        filename = f"{student_name}_questions.csv"
        filepath = self.output_dir / filename
        
        fieldnames = ['question_number', 'question_type', 'question', 'rationale', 'code_reference']
        
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            
            for q in questions:
                row = {field: q.get(field, '') for field in fieldnames}
                writer.writerow(row)
        
        return filepath

    def _has_stored_questions(self, student_id: str, assessment_id: str) -> bool:
        resp = self.table.query(
            KeyConditionExpression=(
                Key("PK").eq(f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}")
                & Key("SK").begins_with("QUESTION#")
            ),
            Limit=1,
        )
        return bool(resp.get("Items"))

    def _store_questions_in_dynamodb(
        self,
        questions: List[Dict[str, Any]],
        student_id: str,
        assessment_id: str,
        student_code: str,
        assessment_time_limit: Optional[int] = None,
    ):
        created_at = datetime.now(timezone.utc).isoformat()
        
        with self.table.batch_writer() as batch:
            for q in questions:
                question_id = str(uuid.uuid4())
                
                item: Dict[str, Any] = {
                    'PK': f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}",
                    'SK': f"QUESTION#{question_id}",
                    'id': question_id,
                    'assessmentId': assessment_id,
                    'studentId': student_id,
                    'text': q.get('question', ''),
                    'questionNumber': q.get('question_number', 0),
                    'questionType': q.get('question_type', 'general'),
                    'rationale': q.get('rationale', ''),
                    'codeContext': q.get('code_reference', ''),
                    'difficulty': q.get('difficulty', 'medium') if q.get('difficulty') in ('easy', 'medium', 'hard') else 'medium',
                    'topic': q.get('topic', 'general')[:30] if q.get('topic') else 'general',
                    'createdAt': created_at,
                }
                # Minutes in, seconds stored (the student app expects seconds). Instructors can override per question.
                if assessment_time_limit is not None:
                    item['timeLimit'] = assessment_time_limit * 60
                
                batch.put_item(Item=item)
        
        print(f"[QuestionGenerationService] Stored {len(questions)} questions in DynamoDB")

    # Advisory only; must match the "5 specific + 3 general" in _build_system_prompt. The instructor
    # edit-before-open step is the real quality gate.
    EXPECTED_SPECIFIC_COUNT = 5
    EXPECTED_GENERAL_COUNT = 3

    @staticmethod
    def _normalize_question_text(text: str) -> str:
        return re.sub(r"\s+", " ", (text or "").strip().lower())

    def _validate_questions(self, questions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Drop empty and duplicate questions, coerce unknown question_type to 'general'.

        Count mismatches only warn. Returns [] if nothing valid remains.
        """
        REQUIRED_FIELDS = {"question", "question_type", "question_number"}

        valid: List[Dict[str, Any]] = []
        seen_text: set = set()
        duplicates_dropped = 0
        for q in questions:
            if not q.get("question"):
                logger.warning("Dropping question item with missing 'question' field: %s", q)
                continue

            norm = self._normalize_question_text(q.get("question", ""))
            if norm in seen_text:
                duplicates_dropped += 1
                logger.warning(
                    "Dropping duplicate question (number %s): %.80s",
                    q.get("question_number", "?"), q.get("question", ""),
                )
                continue
            seen_text.add(norm)

            missing = REQUIRED_FIELDS - set(q.keys())
            if missing:
                logger.warning("Question %s missing fields %s, keeping anyway.", q.get("question_number", "?"), missing)
            if q.get("question_type") not in ("specific", "general"):
                logger.warning(
                    "Question %s has unexpected question_type '%s', defaulting to 'general'.",
                    q.get("question_number", "?"), q.get("question_type")
                )
                q["question_type"] = "general"
            valid.append(q)

        if duplicates_dropped:
            logger.warning("Removed %d duplicate question(s) from the generated set.", duplicates_dropped)

        if not valid:
            return []

        specific_count = sum(1 for q in valid if q.get("question_type") == "specific")
        general_count = sum(1 for q in valid if q.get("question_type") == "general")
        if specific_count != self.EXPECTED_SPECIFIC_COUNT:
            logger.warning(
                "Question count mismatch: expected %d specific questions, got %d (after validation/dedupe).",
                self.EXPECTED_SPECIFIC_COUNT, specific_count,
            )
        if general_count != self.EXPECTED_GENERAL_COUNT:
            logger.warning(
                "Question count mismatch: expected %d general questions, got %d (after validation/dedupe).",
                self.EXPECTED_GENERAL_COUNT, general_count,
            )

        return valid
