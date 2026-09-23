import os
from .AgentCoreClient import AgentCoreClient
from .config import get_model_config

from dotenv import load_dotenv
load_dotenv()

AGENTCORE_CLIENT = None

def get_runtime():
    """Lazy process-wide AgentCoreClient singleton."""
    global AGENTCORE_CLIENT
    if AGENTCORE_CLIENT is None:
        AGENTCORE_CLIENT = AgentCoreClient()
    return AGENTCORE_CLIENT
