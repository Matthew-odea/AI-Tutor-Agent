from enum import Enum


class PedagogyMode(str, Enum):
    """Each mode maps to a system prompt file in prompts/."""
    
    EXPLANATORY = "explanatory"  # default; general chat
    
    CONCISE = "concise"  # code assistant; short answers for compact UI
    
    @classmethod
    def get_default(cls) -> "PedagogyMode":
        return cls.EXPLANATORY
    
    @classmethod
    def from_string(cls, mode_str: str) -> "PedagogyMode":
        """Case-insensitive; None gives the default; raises ValueError on unknown modes."""
        if mode_str is None:
            return cls.get_default()
        
        try:
            return cls(mode_str.lower())
        except ValueError:
            valid_modes = ", ".join([mode.value for mode in cls])
            raise ValueError(
                f"Invalid pedagogy mode: '{mode_str}'. "
                f"Valid modes are: {valid_modes}"
            )
    
    def get_prompt_filename(self) -> str:
        prompt_files = {
            self.EXPLANATORY: "general_chat_prompt.md",
            self.CONCISE: "code_assistant_prompt.md",
        }
        return prompt_files[self]
    
    def get_description(self) -> str:
        descriptions = {
            self.EXPLANATORY: "General Chat tutor behavior with clear explanations",
            self.CONCISE: "Code Assistant behavior with short, direct responses",
        }
        return descriptions.get(self, "Unknown mode")
