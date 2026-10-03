"""Keep direct fixture image and build-file dependencies inside infra/odoo."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
result = subprocess.run(
    ['git', 'grep', '-n', '-I', '-E',
     r'opencrane-odoo-(community|database|operator)|infra/odoo/(Dockerfile|compose\.yaml)',
     '--', '.', ':(exclude)infra/odoo/**', ':(exclude)*.md'],
    cwd=root, capture_output=True, text=True)
if result.returncode == 0:
    raise SystemExit('FAIL fixture dependency outside infra/odoo:\n' + result.stdout)
if result.returncode != 1:
    raise SystemExit(result.stderr)
print('PASS fixture images and build files have no external direct dependencies')
