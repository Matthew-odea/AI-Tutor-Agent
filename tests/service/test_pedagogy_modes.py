import pytest
from src.main.dtos.PedagogyMode import PedagogyMode
from src.main.service.PromptService import PromptService


class TestPedagogyModeEnum:
    def test_all_modes_defined(self):
        expected_modes = {"explanatory", "concise"}
        actual_modes = {mode.value for mode in PedagogyMode}
        assert actual_modes == expected_modes
    
    def test_default_mode(self):
        default = PedagogyMode.get_default()
        assert default == PedagogyMode.EXPLANATORY
        assert default.value == "explanatory"
    
    def test_from_string_valid(self):
        assert PedagogyMode.from_string("concise") == PedagogyMode.CONCISE
        assert PedagogyMode.from_string("EXPLANATORY") == PedagogyMode.EXPLANATORY  # Case-insensitive
        assert PedagogyMode.from_string("ConCISe") == PedagogyMode.CONCISE
    
    def test_from_string_none(self):
        result = PedagogyMode.from_string(None)
        assert result == PedagogyMode.EXPLANATORY
    
    def test_from_string_invalid(self):
        with pytest.raises(ValueError, match="Invalid pedagogy mode"):
            PedagogyMode.from_string("invalid_mode")
    
    def test_get_prompt_filename(self):
        assert PedagogyMode.EXPLANATORY.get_prompt_filename() == "general_chat_prompt.md"
        assert PedagogyMode.CONCISE.get_prompt_filename() == "code_assistant_prompt.md"
    
    def test_get_description(self):
        for mode in PedagogyMode:
            description = mode.get_description()
            assert isinstance(description, str)
            assert len(description) > 0


class TestPromptService:
    @pytest.fixture
    def prompt_service(self):
        return PromptService()
    
    def test_initialization(self, prompt_service):
        assert prompt_service.prompts_dir.exists()
        assert prompt_service.prompts_dir.name == "prompts"
    
    def test_load_all_modes(self, prompt_service):
        for mode in PedagogyMode:
            prompt = prompt_service.get_mode_prompt(mode)
            assert isinstance(prompt, str)
            assert len(prompt) > 100  # Should be substantial
    
    def test_prompt_caching(self, prompt_service):
        mode = PedagogyMode.CONCISE
        
        prompt1 = prompt_service.get_mode_prompt(mode)
        assert mode.value in prompt_service._prompt_cache
        
        prompt2 = prompt_service.get_mode_prompt(mode)
        assert prompt1 == prompt2
        assert prompt1 is prompt2  # Same object reference
    
    def test_validate_mode_valid(self, prompt_service):
        result = prompt_service.validate_mode("concise")
        assert result == PedagogyMode.CONCISE
    
    def test_validate_mode_invalid(self, prompt_service):
        with pytest.raises(ValueError):
            prompt_service.validate_mode("invalid")
    
    def test_get_mode_description(self, prompt_service):
        description = prompt_service.get_mode_description(PedagogyMode.CONCISE)
        assert isinstance(description, str)
        assert len(description) > 0
    
    def test_list_available_modes(self, prompt_service):
        modes = prompt_service.list_available_modes()
        assert len(modes) == 2
        
        for mode_info in modes:
            assert "mode" in mode_info
            assert "description" in mode_info
            assert "prompt_file" in mode_info
            assert mode_info["prompt_file"].endswith(".md")
    
    def test_clear_cache(self, prompt_service):
        prompt_service.get_mode_prompt(PedagogyMode.CONCISE)
        assert len(prompt_service._prompt_cache) > 0
        
        prompt_service.clear_cache()
        assert len(prompt_service._prompt_cache) == 0
    
    def test_preload_all_prompts(self, prompt_service):
        prompt_service.clear_cache()
        assert len(prompt_service._prompt_cache) == 0
        
        prompt_service.preload_all_prompts()
        assert len(prompt_service._prompt_cache) == len(PedagogyMode)
    
    def test_get_combined_prompt(self, prompt_service):
        base = "You are an AI tutor."
        combined = prompt_service.get_combined_prompt(base, PedagogyMode.CONCISE)
        
        assert base in combined
        assert "assistant" in combined.lower() or "concise" in combined.lower()
        assert "---" in combined  # Separator


class TestConversationMemoryPedagogyMode:
    @pytest.fixture
    def memory(self, conversation_memory):
        return conversation_memory
    
    def test_default_pedagogy_mode(self, memory):
        memory.add_message("session-1", "user", "Hello")
        mode = memory.get_pedagogy_mode("session-1")
        assert mode == "explanatory"
    
    def test_set_pedagogy_mode(self, memory):
        session_id = "test-session"
        memory.set_pedagogy_mode(session_id, "concise")
        
        assert memory.get_pedagogy_mode(session_id) == "concise"
    
    def test_set_pedagogy_mode_creates_session(self, memory):
        session_id = "new-session"
        assert not memory.session_exists(session_id)
        
        memory.set_pedagogy_mode(session_id, "concise")
        assert memory.session_exists(session_id)
        assert memory.get_pedagogy_mode(session_id) == "concise"
    
    def test_get_pedagogy_mode_nonexistent_session(self, memory):
        mode = memory.get_pedagogy_mode("nonexistent")
        assert mode == "explanatory"
    
    def test_pedagogy_mode_in_session_info(self, memory):
        session_id = "test-session"
        memory.add_message(session_id, "user", "Hello")
        memory.set_pedagogy_mode(session_id, "concise")
        
        info = memory.get_session_info(session_id)
        assert info["pedagogy_mode"] == "concise"
    
    def test_pedagogy_mode_persists_across_messages(self, memory):
        session_id = "test-session"
        memory.set_pedagogy_mode(session_id, "concise")
        
        memory.add_message(session_id, "user", "Question 1")
        memory.add_message(session_id, "assistant", "Answer 1")
        memory.add_message(session_id, "user", "Question 2")
        
        assert memory.get_pedagogy_mode(session_id) == "concise"
    
    def test_different_modes_different_sessions(self, memory):
        memory.set_pedagogy_mode("session-1", "concise")
        memory.set_pedagogy_mode("session-2", "explanatory")
        memory.set_pedagogy_mode("session-3", "explanatory")
        
        assert memory.get_pedagogy_mode("session-1") == "concise"
        assert memory.get_pedagogy_mode("session-2") == "explanatory"
        assert memory.get_pedagogy_mode("session-3") == "explanatory"


class TestPromptContentValidation:
    @pytest.fixture
    def prompt_service(self):
        return PromptService()
    
    def test_concise_prompt_content(self, prompt_service):
        """Concise uses the code assistant prompt file."""
        assert PedagogyMode.CONCISE.get_prompt_filename() == "code_assistant_prompt.md"
    
    def test_explanatory_prompt_content(self, prompt_service):
        prompt = prompt_service.get_mode_prompt(PedagogyMode.EXPLANATORY)
        
        assert "explain" in prompt.lower() or "explanation" in prompt.lower()
        assert "example" in prompt.lower()
    
    def test_concise_prompt_text(self, prompt_service):
        prompt = prompt_service.get_mode_prompt(PedagogyMode.CONCISE)
        assert "direct" in prompt.lower() or "concise" in prompt.lower() or "assistant" in prompt.lower()


class TestModeIntegration:
    @pytest.fixture
    def memory(self, conversation_memory):
        return conversation_memory

    @pytest.fixture
    def prompt_service(self):
        return PromptService()
    
    def test_full_mode_workflow(self, memory, prompt_service):
        session_id = "integration-test"
        mode_str = "concise"
        
        mode = prompt_service.validate_mode(mode_str)
        assert mode == PedagogyMode.CONCISE
        
        memory.set_pedagogy_mode(session_id, mode.value)
        
        retrieved_mode = memory.get_pedagogy_mode(session_id)
        assert retrieved_mode == mode_str
        
        prompt = prompt_service.get_mode_prompt(mode)
        assert len(prompt) > 0
        
        info = memory.get_session_info(session_id)
        assert info["pedagogy_mode"] == mode_str
    
    def test_mode_switching(self, memory, prompt_service):
        session_id = "mode-switch-test"
        
        memory.set_pedagogy_mode(session_id, "concise")
        memory.add_message(session_id, "user", "Question 1")
        assert memory.get_pedagogy_mode(session_id) == "concise"
        
        memory.set_pedagogy_mode(session_id, "explanatory")
        memory.add_message(session_id, "user", "Question 2")
        assert memory.get_pedagogy_mode(session_id) == "explanatory"
        
        # All messages should still be in history
        history = memory.get_history(session_id)
        assert len(history) == 2
