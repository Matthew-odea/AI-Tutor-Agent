"""Wires the evaluation engine, repository and workflow runner; evaluation jobs arrive via SQS."""
from typing import Optional
from pathlib import Path

from src.main.service.ResponseEvaluationEngine import ResponseEvaluationEngine
from src.main.service.ResponseEvaluationRepository import ResponseEvaluationRepository
from src.main.service.EvaluationWorkflowRunner import EvaluationWorkflowRunner
from src.main.llm.AgentCoreProvider import AgentCoreProvider
from src.main.utils.ReadPrompt import read_prompt


class ResponseEvaluationError(Exception):
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

        prompt_file = Path(__file__).resolve().parents[3] / "prompts" / "response_evaluation_prompt.md"
        self.evaluation_prompt = read_prompt(prompt_file)
        self.engine = ResponseEvaluationEngine(agent_client=self.agent_client, evaluation_prompt=self.evaluation_prompt)
        self.workflow_runner = EvaluationWorkflowRunner(
            engine=self.engine,
            repository=self.repository,
            transcription_service=transcription_service,
        )
