"""Loads and caches per-pedagogy-mode prompt files from prompts/."""
import os
import logging
from typing import Optional
from pathlib import Path
from src.main.dtos.PedagogyMode import PedagogyMode

logger = logging.getLogger(__name__)


class PromptService:
    def __init__(self, prompts_dir: Optional[str] = None):
        if prompts_dir is None:
            project_root = Path(__file__).parent.parent.parent.parent
            prompts_dir = project_root / "prompts"
        
        self.prompts_dir = Path(prompts_dir)
        self._prompt_cache: dict[str, str] = {}
        
        logger.info(f"PromptService initialized with prompts_dir={self.prompts_dir}")
    
    def get_mode_prompt(self, mode: PedagogyMode) -> str:
        """Accepts a PedagogyMode or its string value."""
        if isinstance(mode, str):
            mode = PedagogyMode.from_string(mode)
        
        cache_key = mode.value
        if cache_key in self._prompt_cache:
            logger.debug(f"Returning cached prompt for mode '{mode.value}'")
            return self._prompt_cache[cache_key]
        
        filename = mode.get_prompt_filename()
        filepath = self.prompts_dir / filename
        
        if not filepath.exists():
            error_msg = f"Prompt file not found: {filepath}"
            logger.error(error_msg)
            raise FileNotFoundError(error_msg)
        
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                prompt_content = f.read()
            
            self._prompt_cache[cache_key] = prompt_content
            logger.info(f"Loaded and cached prompt for mode '{mode.value}' from {filename}")
            
            return prompt_content
        
        except Exception as e:
            logger.error(f"Error loading prompt file {filepath}: {e}")
            raise
    
    def get_combined_prompt(
        self, 
        base_prompt: str, 
        mode: PedagogyMode,
        separator: str = "\n\n---\n\n"
    ) -> str:
        mode_prompt = self.get_mode_prompt(mode)
        combined = f"{base_prompt}{separator}{mode_prompt}"
        
        logger.debug(f"Combined base prompt with {mode.value} mode prompt ({len(combined)} chars)")
        return combined
    
    def validate_mode(self, mode_str: Optional[str]) -> PedagogyMode:
        """None returns the default mode; raises ValueError on an unknown mode."""
        try:
            mode = PedagogyMode.from_string(mode_str)
            logger.debug(f"Validated mode: '{mode.value}'")
            return mode
        except ValueError as e:
            logger.error(f"Invalid pedagogy mode: {mode_str}")
            raise
    
    def get_mode_description(self, mode: PedagogyMode) -> str:
        if isinstance(mode, str):
            mode = PedagogyMode.from_string(mode)
        
        return mode.get_description()
    
    def list_available_modes(self) -> list[dict]:
        modes = []
        for mode in PedagogyMode:
            modes.append({
                "mode": mode.value,
                "description": mode.get_description(),
                "prompt_file": mode.get_prompt_filename()
            })
        
        return modes
    
    def clear_cache(self):
        self._prompt_cache.clear()
        logger.info("Cleared prompt cache")
    
    def preload_all_prompts(self):
        """Load every mode's prompt so a missing file fails at startup."""
        logger.info("Preloading all pedagogy mode prompts...")
        
        for mode in PedagogyMode:
            try:
                self.get_mode_prompt(mode)
                logger.debug(f"  ✓ Loaded {mode.value} mode prompt")
            except Exception as e:
                logger.error(f"  ✗ Failed to load {mode.value} mode prompt: {e}")
                raise
        
        logger.info(f"Successfully preloaded {len(PedagogyMode)} mode prompts")


_prompt_service_instance: Optional[PromptService] = None


def get_prompt_service() -> PromptService:
    global _prompt_service_instance
    
    if _prompt_service_instance is None:
        _prompt_service_instance = PromptService()
        try:
            _prompt_service_instance.preload_all_prompts()
        except Exception as e:
            logger.warning(f"Failed to preload prompts (will load on-demand): {e}")
    
    return _prompt_service_instance
