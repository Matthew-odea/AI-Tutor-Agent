"""
test_pedagogy_modes.py
Unit tests for pedagogy mode functionality.
"""
import pytest
from src.main.dtos.PedagogyMode import PedagogyMode
from src.main.service.PromptService import PromptService


class TestPedagogyModeEnum:
    """Test PedagogyMode enum functionality."""
    
    def test_all_modes_defined(self):
        """Test that all expected modes are defined."""
        expected_modes = {"explanatory", "concise"}
        actual_modes = {mode.value for mode in PedagogyMode}
        assert actual_modes == expected_modes
    
    def test_default_mode(self):
        """Test that default mode is explanatory."""
        default = PedagogyMode.get_default()
        assert default == PedagogyMode.EXPLANATORY
        assert default.value == "explanatory"
    
    def test_from_string_valid(self):
        """Test converting valid strings to PedagogyMode."""
        assert PedagogyMode.from_string("concise") == PedagogyMode.CONCISE
        assert PedagogyMode.from_string("EXPLANATORY") == PedagogyMode.EXPLANATORY  # Case-insensitive
        assert PedagogyMode.from_string("ConCISe") == PedagogyMode.CONCISE
    
    def test_from_string_none(self):
        """Test that None returns default mode."""
        result = PedagogyMode.from_string(None)
        assert result == PedagogyMode.EXPLANATORY
    
    def test_from_string_invalid(self):
        """Test that invalid string raises ValueError."""
        with pytest.raises(ValueError, match="Invalid pedagogy mode"):
            PedagogyMode.from_string("invalid_mode")
    
    def test_get_prompt_filename(self):
        """Test that prompt filenames are correctly generated."""
        assert PedagogyMode.EXPLANATORY.get_prompt_filename() == "general_chat_prompt.md"
        assert PedagogyMode.CONCISE.get_prompt_filename() == "code_assistant_prompt.md"
    
    def test_get_description(self):
        """Test that mode descriptions are available."""
        for mode in PedagogyMode:
            description = mode.get_description()
            assert isinstance(description, str)
            assert len(description) > 0


class TestPromptService:
    """Test PromptService functionality."""
    
    @pytest.fixture
    def prompt_service(self):
        """Create a PromptService instance."""
        return PromptService()
    
    def test_initialization(self, prompt_service):
        """Test that PromptService initializes correctly."""
        assert prompt_service.prompts_dir.exists()
        assert prompt_service.prompts_dir.name == "prompts"
    
    def test_load_all_modes(self, prompt_service):
        """Test that all pedagogy mode prompts can be loaded."""
        for mode in PedagogyMode:
            prompt = prompt_service.get_mode_prompt(mode)
            assert isinstance(prompt, str)
            assert len(prompt) > 100  # Should be substantial
    
    def test_prompt_caching(self, prompt_service):
        """Test that prompts are cached after first load."""
        mode = PedagogyMode.CONCISE
        
        # First load
        prompt1 = prompt_service.get_mode_prompt(mode)
        assert mode.value in prompt_service._prompt_cache
        
        # Second load (from cache)
        prompt2 = prompt_service.get_mode_prompt(mode)
        assert prompt1 == prompt2
        assert prompt1 is prompt2  # Same object reference
    
    def test_validate_mode_valid(self, prompt_service):
        """Test validating valid mode strings."""
        result = prompt_service.validate_mode("concise")
        assert result == PedagogyMode.CONCISE
    
    def test_validate_mode_invalid(self, prompt_service):
        """Test validating invalid mode strings."""
        with pytest.raises(ValueError):
            prompt_service.validate_mode("invalid")
    
    def test_get_mode_description(self, prompt_service):
        """Test getting mode descriptions."""
        description = prompt_service.get_mode_description(PedagogyMode.CONCISE)
        assert isinstance(description, str)
        assert len(description) > 0
    
    def test_list_available_modes(self, prompt_service):
        """Test listing all available modes."""
        modes = prompt_service.list_available_modes()
        assert len(modes) == 2
        
        for mode_info in modes:
            assert "mode" in mode_info
            assert "description" in mode_info
            assert "prompt_file" in mode_info
            assert mode_info["prompt_file"].endswith(".md")
    
    def test_clear_cache(self, prompt_service):
        """Test clearing the prompt cache."""
        # Load a prompt to populate cache
        prompt_service.get_mode_prompt(PedagogyMode.CONCISE)
        assert len(prompt_service._prompt_cache) > 0
        
        # Clear cache
        prompt_service.clear_cache()
        assert len(prompt_service._prompt_cache) == 0
    
    def test_preload_all_prompts(self, prompt_service):
        """Test preloading all prompts at once."""
        prompt_service.clear_cache()
        assert len(prompt_service._prompt_cache) == 0
        
        prompt_service.preload_all_prompts()
        assert len(prompt_service._prompt_cache) == len(PedagogyMode)
    
    def test_get_combined_prompt(self, prompt_service):
        """Test combining base prompt with mode prompt."""
        base = "You are an AI tutor."
        combined = prompt_service.get_combined_prompt(base, PedagogyMode.CONCISE)
        
        assert base in combined
        assert "assistant" in combined.lower() or "concise" in combined.lower()
        assert "---" in combined  # Separator


class TestConversationMemoryPedagogyMode:
    """Test pedagogy mode tracking in the conversation store."""

    @pytest.fixture
    def memory(self, conversation_memory):
        return conversation_memory
    
    def test_default_pedagogy_mode(self, memory):
        """Test that new sessions default to explanatory mode."""
        memory.add_message("session-1", "user", "Hello")
        mode = memory.get_pedagogy_mode("session-1")
        assert mode == "explanatory"
    
    def test_set_pedagogy_mode(self, memory):
        """Test setting pedagogy mode for a session."""
        session_id = "test-session"
        memory.set_pedagogy_mode(session_id, "concise")
        
        assert memory.get_pedagogy_mode(session_id) == "concise"
    
    def test_set_pedagogy_mode_creates_session(self, memory):
        """Test that setting mode creates session if it doesn't exist."""
        session_id = "new-session"
        assert not memory.session_exists(session_id)
        
        memory.set_pedagogy_mode(session_id, "concise")
        assert memory.session_exists(session_id)
        assert memory.get_pedagogy_mode(session_id) == "concise"
    
    def test_get_pedagogy_mode_nonexistent_session(self, memory):
        """Test getting mode for non-existent session returns default."""
        mode = memory.get_pedagogy_mode("nonexistent")
        assert mode == "explanatory"
    
    def test_pedagogy_mode_in_session_info(self, memory):
        """Test that pedagogy mode is included in session info."""
        session_id = "test-session"
        memory.add_message(session_id, "user", "Hello")
        memory.set_pedagogy_mode(session_id, "concise")
        
        info = memory.get_session_info(session_id)
        assert info["pedagogy_mode"] == "concise"
    
    def test_pedagogy_mode_persists_across_messages(self, memory):
        """Test that pedagogy mode persists as messages are added."""
        session_id = "test-session"
        memory.set_pedagogy_mode(session_id, "concise")
        
        # Add multiple messages
        memory.add_message(session_id, "user", "Question 1")
        memory.add_message(session_id, "assistant", "Answer 1")
        memory.add_message(session_id, "user", "Question 2")
        
        # Mode should still be the same
        assert memory.get_pedagogy_mode(session_id) == "concise"
    
    def test_different_modes_different_sessions(self, memory):
        """Test that different sessions can have different modes."""
        memory.set_pedagogy_mode("session-1", "concise")
        memory.set_pedagogy_mode("session-2", "explanatory")
        memory.set_pedagogy_mode("session-3", "explanatory")
        
        assert memory.get_pedagogy_mode("session-1") == "concise"
        assert memory.get_pedagogy_mode("session-2") == "explanatory"
        assert memory.get_pedagogy_mode("session-3") == "explanatory"


class TestPromptContentValidation:
    """Test that pedagogy mode prompts contain expected content."""
    
    @pytest.fixture
    def prompt_service(self):
        return PromptService()
    
    def test_concise_prompt_content(self, prompt_service):
        """Test that Concise uses the code assistant prompt file."""
        assert PedagogyMode.CONCISE.get_prompt_filename() == "code_assistant_prompt.md"
    
    def test_explanatory_prompt_content(self, prompt_service):
        """Test that Explanatory prompt emphasizes clear explanations."""
        prompt = prompt_service.get_mode_prompt(PedagogyMode.EXPLANATORY)
        
        assert "explain" in prompt.lower() or "explanation" in prompt.lower()
        assert "example" in prompt.lower()
    
    def test_concise_prompt_text(self, prompt_service):
        """Test that Concise prompt emphasizes direct coding support."""
        prompt = prompt_service.get_mode_prompt(PedagogyMode.CONCISE)
        assert "direct" in prompt.lower() or "concise" in prompt.lower() or "assistant" in prompt.lower()


class TestModeIntegration:
    """Integration tests for mode functionality across components."""
    
    @pytest.fixture
    def memory(self, conversation_memory):
        return conversation_memory

    @pytest.fixture
    def prompt_service(self):
        return PromptService()
    
    def test_full_mode_workflow(self, memory, prompt_service):
        """Test complete workflow of using a pedagogy mode."""
        session_id = "integration-test"
        mode_str = "concise"
        
        # 1. Validate mode
        mode = prompt_service.validate_mode(mode_str)
        assert mode == PedagogyMode.CONCISE
        
        # 2. Set mode in session
        memory.set_pedagogy_mode(session_id, mode.value)
        
        # 3. Get mode from session
        retrieved_mode = memory.get_pedagogy_mode(session_id)
        assert retrieved_mode == mode_str
        
        # 4. Load prompt for mode
        prompt = prompt_service.get_mode_prompt(mode)
        assert len(prompt) > 0
        
        # 5. Verify session info includes mode
        info = memory.get_session_info(session_id)
        assert info["pedagogy_mode"] == mode_str
    
    def test_mode_switching(self, memory, prompt_service):
        """Test switching between modes in a session."""
        session_id = "mode-switch-test"
        
        # Start with concise
        memory.set_pedagogy_mode(session_id, "concise")
        memory.add_message(session_id, "user", "Question 1")
        assert memory.get_pedagogy_mode(session_id) == "concise"
        
        # Switch to explanatory
        memory.set_pedagogy_mode(session_id, "explanatory")
        memory.add_message(session_id, "user", "Question 2")
        assert memory.get_pedagogy_mode(session_id) == "explanatory"
        
        # All messages should still be in history
        history = memory.get_history(session_id)
        assert len(history) == 2
