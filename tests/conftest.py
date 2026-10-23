import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("MOSS_DATA_DIR", tempfile.mkdtemp(prefix="moss-test-"))
