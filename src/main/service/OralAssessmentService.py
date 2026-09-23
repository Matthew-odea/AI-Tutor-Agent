"""Student-side oral/written assessment flow: question access, answer submission, progress, results."""

from __future__ import annotations
import logging
import os
import json
import boto3
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
from decimal import Decimal
from boto3.dynamodb.conditions import Key
from src.main.service.OralAssessmentProgressTracker import OralAssessmentProgressTracker
from src.main.service.OralAssessmentQuestionAccess import OralAssessmentQuestionAccess
from src.main.service.OralAssessmentAnswerSubmission import OralAssessmentAnswerSubmission
from src.main.service.OralAssessmentResultsAggregator import OralAssessmentResultsAggregator
from src.main.service.S3UploadService import assert_owned_upload

logger = logging.getLogger(__name__)


class OralAssessmentServiceError(Exception):
    pass


class AssessmentWindowError(OralAssessmentServiceError):
    """The assessment's stored time limits refuse this request now.

    ``code`` is the error-envelope code the router returns, so the student app
    can tell "time is up" apart from every other 400/404.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super(DecimalEncoder, self).default(obj)


class OralAssessmentService:
    
    def __init__(self):
        self.region = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
        self.table_name = os.getenv("DYNAMODB_ASSESSMENT_TABLE", "oral_assessments")
        self.s3_bucket = os.getenv("S3_ASSESSMENT_BUCKET", "c9-oral-assessments")
        
        try:
            self.dynamodb = boto3.resource('dynamodb', region_name=self.region)
            self.table = self.dynamodb.Table(self.table_name)
            
            self.s3 = boto3.client('s3', region_name=self.region)
            self.question_access = OralAssessmentQuestionAccess(table=self.table)
            self.progress_tracker = OralAssessmentProgressTracker(
                table=self.table, question_access=self.question_access
            )
            self.answer_submission = OralAssessmentAnswerSubmission(
                table=self.table,
                progress_updater=self._update_progress,
            )
            # Bucket may live in a different region than DynamoDB; presigned URLs need the bucket's region.
            try:
                bucket_loc = self.s3.get_bucket_location(Bucket=self.s3_bucket)
                s3_region = bucket_loc.get("LocationConstraint") or "us-east-1"
            except Exception:
                s3_region = self.region
            self.results_aggregator = OralAssessmentResultsAggregator(
                table=self.table,
                s3_bucket=self.s3_bucket,
                s3_region=s3_region,
            )
            
            logger.info(f"Connected to DynamoDB table: {self.table_name}")
            logger.info(f"Using S3 bucket: {self.s3_bucket}")
        except Exception as e:
            raise OralAssessmentServiceError(f"Failed to connect to AWS: {e}")
    
    def _convert_decimals(self, obj: Any) -> Any:
        if isinstance(obj, list):
            return [self._convert_decimals(i) for i in obj]
        elif isinstance(obj, dict):
            return {k: self._convert_decimals(v) for k, v in obj.items()}
        elif isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return obj
    
    def _update_progress(self, student_id: str, assessment_id: str):
        try:
            self.progress_tracker.update_progress(student_id, assessment_id)
        except Exception as e:
            logger.warning(f"Failed to update progress: {e}")
    
    def _get_assessment_metadata(self, assessment_id: str) -> Dict[str, Any]:
        response = self.table.get_item(
            Key={"PK": f"ASSESSMENT#{assessment_id}", "SK": "METADATA"}
        )
        item = response.get("Item")
        if not item:
            raise OralAssessmentServiceError(f"Assessment {assessment_id} not found")
        return item

    def _check_assessment_window(self, assessment_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Raise if a scheduled assessment is outside its window. Pass metadata to skip a re-read."""
        try:
            item = metadata if metadata is not None else self._get_assessment_metadata(assessment_id)

            if item.get("accessMode", "open") != "scheduled":
                return

            window_start = item.get("scheduledWindowStart")
            window_end = item.get("scheduledWindowEnd")

            if not window_start or not window_end:
                return  # scheduled but no window set: fail open

            now = datetime.now(timezone.utc)

            def _parse(dt_str):
                parsed = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
                return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

            start = _parse(window_start)
            end = _parse(window_end)

            if now < start:
                raise AssessmentWindowError(
                    "assessment_not_open",
                    f"Assessment has not started yet. Opens at {window_start}",
                )
            if now > end:
                raise AssessmentWindowError(
                    "assessment_closed",
                    f"Assessment window has closed at {window_end}",
                )
        except OralAssessmentServiceError:
            raise
        except Exception as e:
            logger.error(f"Window check failed for assessment {assessment_id}: {e}")
            raise OralAssessmentServiceError(f"Unable to verify assessment availability. Please try again.")

    def get_student_questions(
        self,
        student_id: str,
        assessment_id: str
    ) -> List[Dict[str, Any]]:
        """Return a dict of (gated) questions, current index and assessment behaviour flags."""
        try:
            self.question_access.ensure_student_enrollment(student_id, assessment_id)

            assessment_meta = self._get_assessment_metadata(assessment_id)
            self._check_assessment_window(assessment_id, metadata=assessment_meta)
            # timeLimit is seconds, and null in the formative flow; coerce before int().
            raw_time_limit = int(assessment_meta.get("timeLimit") or 0) or None
            assessment_time_limit = raw_time_limit

            # Legacy assessments have no proctored field; infer it from answerMode.
            answer_mode = assessment_meta.get("answerMode", "oral")
            proctored = assessment_meta.get("proctored")
            if proctored is None:
                proctored = answer_mode == "oral"
            allow_review = bool(assessment_meta.get("allowReview", False))

            student_items = self.question_access.get_student_questions(student_id, assessment_id)
            # BANK_QUESTION# items are no longer read: the feature was removed and the only
            # prod items (2026-09-23) sit in an unanswered draft smoke-test assessment.

            if not student_items:
                logger.warning(f"No questions found for assessment {assessment_id}")
                return {"questions": [], "currentQuestionIndex": 0,
                        "answerMode": answer_mode,
                        "preparationTime": assessment_meta.get("preparationTime"),
                        "proctored": proctored,
                        "allowReview": allow_review,
                        "assessmentTitle": assessment_meta.get("title"),
                        "assessmentCourse": assessment_meta.get("course"),
                        "assessmentDescription": assessment_meta.get("description")}

            # Sort must be deterministic: questionOrder is frozen from it on first access.
            all_questions = self.question_access.to_student_question_view(
                student_items,
                student_id=student_id,
                assessment_id=assessment_id,
                assessment_time_limit=assessment_time_limit,
            )
            question_ids = [q["id"] for q in all_questions]

            enrollment_key = {"PK": f"ASSESSMENT#{assessment_id}", "SK": f"STUDENT#{student_id}"}
            enrollment_resp = self.table.get_item(Key=enrollment_key)
            enrollment = enrollment_resp.get("Item", {})

            # First access: freeze question order and record startedAt
            if "questionOrder" not in enrollment:
                # Legacy students may already have answers from before questionOrder existed.
                answers_resp = self.table.query(
                    KeyConditionExpression=Key("PK").eq(f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}")
                        & Key("SK").begins_with("ANSWER#"),
                    Select="COUNT",
                )
                existing_answers = answers_resp.get("Count", 0)
                try:
                    self.table.update_item(
                        Key=enrollment_key,
                        UpdateExpression="SET questionOrder = :qo, currentQuestionIdx = :ci, startedAt = if_not_exists(startedAt, :t)",
                        ConditionExpression="attribute_not_exists(questionOrder)",
                        ExpressionAttributeValues={
                            ":qo": question_ids,
                            ":ci": existing_answers,
                            ":t": datetime.now(timezone.utc).isoformat(),
                        },
                    )
                    current_idx = existing_answers
                except self.table.meta.client.exceptions.ConditionalCheckFailedException:
                    # Another request froze the order first; use its value.
                    enrollment = self.table.get_item(Key=enrollment_key).get("Item", {})
                    current_idx = int(enrollment.get("currentQuestionIdx", 0))
            else:
                current_idx = int(enrollment.get("currentQuestionIdx", 0))

            if allow_review:
                # All questions navigable; attach prior answers so the UI can pre-fill.
                answers_resp = self.table.query(
                    KeyConditionExpression=Key("PK").eq(f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}")
                        & Key("SK").begins_with("ANSWER#")
                )
                answers_by_qid = {a.get("questionId"): a for a in answers_resp.get("Items", [])}
                for q in all_questions:
                    prior = answers_by_qid.get(q.get("id"))
                    if prior is not None:
                        q["priorAnswer"] = prior.get("textContent")
                gated_questions = all_questions
            else:
                gated_questions = self.question_access.gate_question_content(all_questions, current_idx)

            logger.info(f"Retrieved {len(gated_questions)} questions for student {student_id} (current={current_idx})")
            return {
                "questions": self._convert_decimals(gated_questions),
                "currentQuestionIndex": current_idx,
                "answerMode": answer_mode,
                "preparationTime": assessment_meta.get("preparationTime"),
                "proctored": proctored,
                "allowReview": allow_review,
                "assessmentTitle": assessment_meta.get("title"),
                "assessmentCourse": assessment_meta.get("course"),
                "assessmentDescription": assessment_meta.get("description"),
            }
            
        except ValueError as e:
            raise OralAssessmentServiceError(str(e))
        except OralAssessmentServiceError:
            raise
        except Exception as e:
            logger.error(f"Failed to get questions: {e}")
            raise OralAssessmentServiceError(f"Database error: {e}")
    
    def _validate_question_order(self, student_id: str, assessment_id: str, question_id: str, allow_review: bool = False) -> None:
        """Reject duplicates and out-of-order answers; review mode only requires the question be in this student's order.

        Does not advance the index."""
        enrollment_key = {"PK": f"ASSESSMENT#{assessment_id}", "SK": f"STUDENT#{student_id}"}
        enrollment = self.table.get_item(Key=enrollment_key).get("Item")
        if not enrollment:
            raise OralAssessmentServiceError("Student not enrolled in this assessment")

        question_order = enrollment.get("questionOrder", [])
        current_idx = int(enrollment.get("currentQuestionIdx", 0))

        if allow_review:
            if question_id not in question_order:
                raise OralAssessmentServiceError("Question submitted out of order")
            return

        existing = self.table.get_item(
            Key={"PK": f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}", "SK": f"ANSWER#{question_id}"}
        )
        if "Item" in existing:
            raise OralAssessmentServiceError("Answer already submitted for this question")

        if current_idx >= len(question_order) or question_order[current_idx] != question_id:
            raise OralAssessmentServiceError("Question submitted out of order")

    def _advance_question_index(self, student_id: str, assessment_id: str, allow_review: bool = False, question_id: Optional[str] = None) -> None:
        """Advance currentQuestionIdx after an answer is stored.

        In review mode the index is a monotonic "furthest reached" marker, so revisions don't move it."""
        enrollment_key = {"PK": f"ASSESSMENT#{assessment_id}", "SK": f"STUDENT#{student_id}"}
        enrollment = self.table.get_item(Key=enrollment_key).get("Item", {})
        current_idx = int(enrollment.get("currentQuestionIdx", 0))

        if allow_review:
            question_order = enrollment.get("questionOrder", [])
            at_frontier = current_idx < len(question_order) and question_order[current_idx] == question_id
            if not at_frontier:
                return

        try:
            self.table.update_item(
                Key=enrollment_key,
                UpdateExpression="SET currentQuestionIdx = :new_idx",
                ConditionExpression="currentQuestionIdx = :old_idx",
                ExpressionAttributeValues={":new_idx": current_idx + 1, ":old_idx": current_idx},
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            pass  # a concurrent request already advanced; the answer is stored, so this is safe

    def submit_answer(
        self,
        student_id: str,
        question_id: str,
        assessment_id: str,
        answer_type: str = "audio",
        audio_url: Optional[str] = None,
        duration: Optional[int] = None,
        text_content: Optional[str] = None,
        video_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """answer_type is 'audio', 'text', 'video' or 'skipped'; duration is seconds."""
        try:
            for label, url in (("audio_url", audio_url), ("video_url", video_url)):
                if url:
                    # build_upload_key writes answer media under audio/{uploader}/.
                    assert_owned_upload(url, f"audio/{student_id}/", label)
            meta = self._get_assessment_metadata(assessment_id)
            allow_review = bool(meta.get("allowReview", False))
            self._check_assessment_window(assessment_id, metadata=meta)
            self._validate_question_order(student_id, assessment_id, question_id, allow_review=allow_review)
            result = self.answer_submission.submit_answer(
                student_id=student_id,
                question_id=question_id,
                assessment_id=assessment_id,
                answer_type=answer_type,
                audio_url=audio_url,
                duration=duration,
                text_content=text_content,
                video_url=video_url,
                allow_review=allow_review,
            )
            self._advance_question_index(student_id, assessment_id, allow_review=allow_review, question_id=question_id)
            logger.info(f"Recorded answer for question {question_id} from student {student_id}")
            return result
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            raise OralAssessmentServiceError("Answer already submitted for this question")
        except ValueError as e:
            raise OralAssessmentServiceError(str(e))
        except OralAssessmentServiceError:
            raise
        except Exception as e:
            logger.error(f"Failed to submit answer: {e}")
            raise OralAssessmentServiceError(f"Database error: {e}")

    def submit_proctor_chunk(
        self,
        student_id: str,
        assessment_id: str,
        chunk_url: str,
        chunk_index: int,
        timestamp: Optional[str] = None,
    ) -> Dict[str, Any]:
        try:
            assert_owned_upload(chunk_url, f"proctoring/{assessment_id}/{student_id}/", "chunk_url")
        except ValueError as e:
            raise OralAssessmentServiceError(str(e))
        try:
            result = self.answer_submission.submit_proctor_chunk(
                student_id=student_id,
                assessment_id=assessment_id,
                chunk_url=chunk_url,
                chunk_index=chunk_index,
                timestamp=timestamp,
            )
            return result
        except Exception as e:
            logger.error(f"Failed to store proctor chunk: {e}")
            raise OralAssessmentServiceError(f"Database error: {e}")
    
    def record_consent(
        self,
        student_id: str,
        assessment_id: str,
        granted: bool,
        consent_version: str,
        timestamp: str,
    ) -> Dict[str, Any]:
        """Store the webcam-consent decision as one CONSENT item in the student-assessment partition.

        It lives there so the instructor's single-partition query picks it up. granted=False is the
        authoritative "declined recording" signal (not a missing item). A later decision overwrites.
        """
        try:
            recorded_at = datetime.now(timezone.utc).isoformat()
            self.table.put_item(Item={
                "PK": f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}",
                "SK": "CONSENT",
                "granted": bool(granted),
                "consentVersion": consent_version,
                "timestamp": timestamp,
                "recordedAt": recorded_at,
            })
            logger.info(
                f"Recorded consent for student {student_id}, assessment "
                f"{assessment_id}: granted={granted}"
            )
            return {
                "ok": True,
                "studentId": student_id,
                "assessmentId": assessment_id,
                "granted": bool(granted),
                "recordedAt": recorded_at,
            }
        except Exception as e:
            logger.error(f"Failed to record consent: {e}")
            raise OralAssessmentServiceError(f"Database error: {e}")

    def submit_assessment(
        self,
        student_id: str,
        assessment_id: str
    ) -> Dict[str, Any]:
        """Final submission. Raises if past due, not all questions answered, or already submitted."""
        try:
            pk = f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}"

            meta = self._get_assessment_metadata(assessment_id)

            try:
                due_date_str = meta.get("dueDate")
                if due_date_str:
                    due = datetime.fromisoformat(due_date_str.replace("Z", "+00:00"))
                    if not due.tzinfo:
                        due = due.replace(tzinfo=timezone.utc)
                    if datetime.now(timezone.utc) > due:
                        raise AssessmentWindowError(
                            "assessment_deadline_passed",
                            f"Assessment submission deadline has passed ({due_date_str})",
                        )
            except OralAssessmentServiceError:
                raise
            except Exception:
                pass  # fail open on an unparseable dueDate

            progress_response = self.table.get_item(
                Key={'PK': pk, 'SK': 'PROGRESS'}
            )
            
            if 'Item' not in progress_response:
                raise OralAssessmentServiceError(
                    f"No progress found for student {student_id} in assessment {assessment_id}"
                )
            
            progress = progress_response['Item']
            total = int(progress.get('totalQuestions', 0))
            answered = int(progress.get('answeredQuestions', 0))
            
            if answered < total:
                raise OralAssessmentServiceError(
                    f"Cannot submit: only {answered}/{total} questions answered"
                )
            
            submitted_at = datetime.now(timezone.utc).isoformat()
            
            enrollment_response = self.table.get_item(
                Key={
                    'PK': f"ASSESSMENT#{assessment_id}",
                    'SK': f"STUDENT#{student_id}"
                }
            )
            
            if 'Item' not in enrollment_response:
                raise OralAssessmentServiceError(
                    f"Student {student_id} not enrolled in assessment {assessment_id}"
                )
            
            # Conditional on submittedAt so a double submit is rejected, not overwritten.
            try:
                self.table.update_item(
                    Key={
                        'PK': f"ASSESSMENT#{assessment_id}",
                        'SK': f"STUDENT#{student_id}"
                    },
                    UpdateExpression='SET #status = :status, submittedAt = :submitted, completedAt = :completed',
                    ConditionExpression='attribute_not_exists(submittedAt)',
                    ExpressionAttributeNames={'#status': 'status'},
                    ExpressionAttributeValues={
                        ':status': 'submitted',
                        ':submitted': submitted_at,
                        ':completed': submitted_at
                    }
                )
            except self.table.meta.client.exceptions.ConditionalCheckFailedException:
                raise OralAssessmentServiceError("Assessment already submitted")
            
            assessment_title = meta.get('title', 'Unknown')
            
            logger.info(f"Student {student_id} submitted assessment {assessment_id}")
            
            return {
                "ok": True,
                "studentId": student_id,
                "assessmentId": assessment_id,
                "status": "submitted",
                "submittedAt": submitted_at,
                "assessmentTitle": assessment_title,
                "questionsAnswered": answered,
                "totalQuestions": total
            }
            
        except OralAssessmentServiceError:
            raise
        except Exception as e:
            logger.error(f"Failed to submit assessment: {e}")
            raise OralAssessmentServiceError(f"Database error: {e}")
    
    def get_student_progress(
        self,
        student_id: str,
        assessment_id: str
    ) -> Dict[str, Any]:
        try:
            enrollment_response = self.table.get_item(
                Key={
                    'PK': f"ASSESSMENT#{assessment_id}",
                    'SK': f"STUDENT#{student_id}"
                }
            )

            if 'Item' not in enrollment_response:
                raise OralAssessmentServiceError(
                    f"Student {student_id} not enrolled in assessment {assessment_id}"
                )

            enrollment = enrollment_response['Item']

            total_questions = self.question_access.count_served_questions(student_id, assessment_id)

            answers_response = self.table.query(
                KeyConditionExpression=Key('PK').eq(f"STUDENT#{student_id}#ASSESSMENT#{assessment_id}") & Key('SK').begins_with('ANSWER#')
            )
            answer_items = answers_response.get('Items', [])
            answered_questions = len(answer_items)
            # Includes skipped answers. The client gates answered/skipped UI on this, not on position.
            answered_question_ids = [
                item['questionId'] for item in answer_items if item.get('questionId')
            ]

            percentage = round((answered_questions / total_questions * 100), 1) if total_questions > 0 else 0

            status = enrollment.get('status', 'not_started')

            assessment_response = self.table.get_item(
                Key={
                    'PK': f"ASSESSMENT#{assessment_id}",
                    'SK': 'METADATA'
                }
            )

            assessment_title = assessment_response.get('Item', {}).get('title', 'Unknown Assessment')

            progress = {
                "studentId": student_id,
                "studentName": enrollment.get('name', ''),
                "studentEmail": enrollment.get('email', ''),
                "assessmentId": assessment_id,
                "assessmentTitle": assessment_title,
                "status": status,
                "totalQuestions": total_questions,
                "answeredQuestions": answered_questions,
                "answeredQuestionIds": answered_question_ids,
                "percentage": percentage,
                "startedAt": enrollment.get('startedAt'),
                "submittedAt": enrollment.get('submittedAt')
            }
            
            logger.info(f"Retrieved progress for student {student_id}: {answered_questions}/{total_questions} answered")
            return self._convert_decimals(progress)
            
        except OralAssessmentServiceError:
            raise
        except Exception as e:
            logger.error(f"Failed to get progress: {e}")
            raise OralAssessmentServiceError(f"Database error: {e}")
    
    def get_student_results(
        self,
        student_id: str,
        assessment_id: str
    ) -> Dict[str, Any]:
        try:
            results = self.results_aggregator.get_student_results(
                student_id=student_id,
                assessment_id=assessment_id,
            )
            logger.info(
                f"Retrieved results for student {student_id}: "
                f"{results.get('percentage', 0)}% ({results.get('grade', 'unknown')})"
            )
            return self._convert_decimals(results)

        except ValueError as e:
            raise OralAssessmentServiceError(str(e))
        except OralAssessmentServiceError:
            raise
        except Exception as e:
            logger.error(f"Failed to get results: {e}")
            raise OralAssessmentServiceError(f"Database error: {e}")
