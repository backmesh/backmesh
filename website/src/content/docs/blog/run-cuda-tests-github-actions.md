---
title: How to run CUDA and PyTorch tests in GitHub Actions
description: A complete GitHub Actions workflow that runs CPU tests on a cheap runner and CUDA or PyTorch tests on an NVIDIA T4 runner, gated by a pull-request label, with pytest markers and a CUDA container variant.
date: 2026-11-24
lastUpdated: 2026-11-24
authors: backmesh
tags:
  - GPU
excerpt: Split your tests with a pytest marker, run the CPU ones on every push, and send the CUDA ones to a T4 runner only when a pull request asks for it. A full workflow, a container variant for nvcc, and what each piece costs.
head:
  - tag: title
    content: 'How to run CUDA and PyTorch tests in GitHub Actions | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"How to run CUDA and PyTorch tests in GitHub Actions","datePublished":"2026-11-24","dateModified":"2026-11-24","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/run-cuda-tests-github-actions/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Can GitHub Actions run CUDA tests?","acceptedAnswer":{"@type":"Answer","text":"Yes, on a runner with an NVIDIA GPU: GitHub''s hosted GPU runner, or a self-hosted one such as backmesh''s backmesh-gpu-t4 in your own AWS or Azure account. ubuntu-latest has no GPU."}},{"@type":"Question","name":"Do I need to install CUDA on the runner?","acceptedAnswer":{"@type":"Answer","text":"The runner needs the NVIDIA driver, which backmesh''s GPU VMs have. The CUDA toolkit comes from your job: PyTorch''s pip wheels bundle the CUDA libraries, and an nvidia/cuda container image brings nvcc."}},{"@type":"Question","name":"How do I keep CPU tests off the GPU runner?","acceptedAnswer":{"@type":"Answer","text":"Mark GPU tests with a pytest marker, run pytest -m \"not gpu\" on a CPU runner, and run pytest -m gpu in a separate job on the GPU runner, gated by a pull-request label or a paths filter."}}]}]}'
---

`ubuntu-latest` has no GPU, so a test that calls CUDA fails or skips there.
The fix is a second job on a GPU runner that runs only the GPU tests, only
when they're needed. This post builds that workflow for a PyTorch project,
then shows the same for CUDA C++ with `nvcc`.

The examples use `backmesh-gpu-t4`, a runner with one NVIDIA T4 on a VM in
your own AWS or Azure account; see [GPU runners](/gpu/) to set it up. On
GitHub's hosted GPU runner, use its label in `runs-on` instead; the rest is
the same.

## 1. Mark the GPU tests

Register a `gpu` marker and put it on every test that needs CUDA:

```toml
# pyproject.toml
[tool.pytest.ini_options]
markers = ["gpu: needs an NVIDIA GPU"]
```

```python
# tests/test_cuda.py
import pytest
import torch


@pytest.mark.gpu
def test_matmul_on_cuda():
    a = torch.randn(512, 512, device="cuda")
    assert torch.allclose(a @ torch.eye(512, device="cuda"), a)
```

`pytest -m "not gpu"` now runs everything else, and `pytest -m gpu` only
these.

## 2. The workflow

```yaml
# .github/workflows/tests.yml
name: tests

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, labeled]

jobs:
  cpu:
    # Adding a label shouldn't rerun the CPU tests.
    if: github.event.action != 'labeled'
    runs-on: backmesh-4
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v6
        with:
          python-version: '3.12'
      - run: pip install torch --index-url https://download.pytorch.org/whl/cpu
      - run: pip install -r requirements.txt
      - run: pytest -m "not gpu"

  gpu:
    # On main, and on pull requests labelled `gpu`.
    if: >-
      github.event_name == 'push' ||
      contains(github.event.pull_request.labels.*.name, 'gpu')
    runs-on: backmesh-gpu-t4
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v6
        with:
          python-version: '3.12'
      - run: nvidia-smi
      - run: pip install torch --index-url https://download.pytorch.org/whl/cu126
      - run: pip install -r requirements.txt
      - run: python -c "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"
      - run: pytest -m gpu
```

What each part does:

- **The CPU job** installs PyTorch's CPU wheel, which is far smaller than
  the CUDA one, and runs every test but the GPU ones on a 4-vCPU runner.
- **The `gpu` label gates the GPU job** on pull requests. Adding the label
  fires the `labeled` event, which starts the GPU job without a new push;
  later pushes to the pull request run it again while the label stays.
  Every push to `main` runs it.
- **`nvidia-smi`** prints the GPU and driver first, so a broken runner shows
  in the log before the install.
- **The CUDA wheel** (`cu126`) bundles the CUDA libraries PyTorch needs, so
  the runner only needs the NVIDIA driver, which backmesh's GPU VMs have.
- **The `torch.cuda.is_available()` check** fails the job if PyTorch can't
  see the GPU, rather than letting tests skip.
- **`timeout-minutes`** caps what a hung GPU test can cost.

To run the GPU job when GPU code changes instead of by label, add a
`paths` filter to a separate workflow for it, listing the directories with
CUDA code.

## 3. CUDA C++ with nvcc

For code you compile with `nvcc`, run the job in NVIDIA's CUDA image, which
has the toolkit. A job's container sees the GPU only with `--gpus all`:

```yaml
cuda:
  if: contains(github.event.pull_request.labels.*.name, 'gpu')
  runs-on: backmesh-gpu-t4
  container:
    image: nvidia/cuda:12.4.1-devel-ubuntu22.04
    options: --gpus all
  steps:
    - uses: actions/checkout@v6
    - run: nvidia-smi
    - run: nvcc -o saxpy tests/saxpy.cu && ./saxpy
```

Pin the image to a CUDA version your driver supports; `nvidia-smi` prints
the highest one.

## What it costs

A GPU minute costs more than a CPU one, which is why the GPU job is gated.
GitHub's T4 runner lists at $0.052 a minute; a T4 VM in your own account
lists at $0.0029 to $0.0088 a minute, spot to on demand, on 2026-11-18. See
[GitHub Actions GPU pricing explained](/blog/github-actions-gpu-pricing/) for
a month worked through. New cloud accounts usually have no GPU quota; see
[Getting T4 GPU quota on AWS and Azure for CI](/blog/t4-gpu-quota-aws-azure/).
