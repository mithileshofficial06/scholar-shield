"""
Service configuration.

TESSERACT_CMD exists because the Windows Tesseract installer does not put the
binary on PATH, and Docker puts it somewhere else again. Rather than requiring
every developer to fix their PATH, the path is configuration with a per-platform
default — and the /health endpoint reports whether it actually resolved, so a
missing binary is visible immediately instead of surfacing as an empty OCR
result three stages downstream.
"""

from __future__ import annotations

import os
import platform
import shutil
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_tesseract_cmd() -> str:
    """Whatever is on PATH, else the platform's usual install location."""
    found = shutil.which("tesseract")
    if found:
        return found
    if platform.system() == "Windows":
        return r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    return "/usr/bin/tesseract"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OCR_", extra="ignore")

    tesseract_cmd: str = _default_tesseract_cmd()
    tesseract_lang: str = "eng"

    # Page segmentation. 6 = "a single uniform block of text", which is what a
    # deskewed certificate is. 3 (fully automatic) splits the seal and the
    # watermark into their own blocks and reorders the lines, which breaks
    # label-anchored extraction.
    tesseract_psm: int = 6

    # Skew search, in degrees. The corpus rotates by up to 3 degrees; the window
    # is wider so a real phone photo is still recoverable.
    max_skew_degrees: float = 6.0
    skew_step_degrees: float = 0.25

    # ELA re-save quality. Fixed, because an ELA response is only comparable
    # across documents if every document is differenced against the same quality.
    ela_quality: int = 90
    # Side of the square block the ELA grid is scored over, in pixels.
    ela_block_size: int = 24

    max_upload_bytes: int = 12 * 1024 * 1024

    @property
    def tesseract_available(self) -> bool:
        return os.path.isfile(self.tesseract_cmd)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
