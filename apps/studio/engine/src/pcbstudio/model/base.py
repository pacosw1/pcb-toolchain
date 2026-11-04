from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Model(BaseModel):
    """Base of every engine shape. Unknown input fields are an error, so a typo in a board.yaml fails loudly."""
    model_config = ConfigDict(extra='forbid')
