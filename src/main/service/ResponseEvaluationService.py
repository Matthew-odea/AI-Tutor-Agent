"""
ResponseEvaluationService: Evaluates student responses to programming questions.

Uses DynamoDB for reading questions/answers and storing evaluation results.
Long-running evaluations are dispatched via SQS and processed by EvaluationWorkflowRunner.
"""
from typing import Optional
from pathlib import Path

from src.main.service.ResponseEvaluationEngine import ResponseEvaluationEngine
from src.main.service.ResponseEvaluationRepository import ResponseEvaluationRepository
from src.main.service.EvaluationWorkflowRunner import EvaluationWorkflowRunner
from src.main.llm.AgentCoreProvider import AgentCoreProvider
from src.main.utils.ReadPrompt import read_prompt


class ResponseEvaluationError(Exception):
    """Raised when evaluation fails."""
    pass


class ResponseEvaluationService:
    def __init__(
        self,
        agent_client: Optional[AgentCoreProvider] = None,
        repository: Optional[ResponseEvaluationRepository] = None,
        transcription_service=None,
    ):
        self.agent_client = agent_client or AgentCoreProvider()
        self.repository = repository or ResponseEvaluationRepository()

        # Load evaluation prompt
        prompt_file = Path(__file__).resolve().parents[3] / "prompts" / "response_evaluation_prompt.md"
        self.evaluation_prompt = read_prompt(prompt_file)
        self.engine = ResponseEvaluationEngine(agent_client=self.agent_client, evaluation_prompt=self.evaluation_prompt)
        self.workflow_runner = EvaluationWorkflowRunner(
            engine=self.engine,
            repository=self.repository,
            transcription_service=transcription_service,
        )
