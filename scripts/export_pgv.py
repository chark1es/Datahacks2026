#!/usr/bin/env python3
"""
Export LOH HDF5 PGV maps to a Float32 binary + JSON manifest for the web game.
Reads 8170242/loh.hdf5 (or path from argv).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

try:
    import h5py
except ImportError as e:
    raise SystemExit(
        "h5py is required: pip install h5py (see scripts/README.md)"
    ) from e


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    h5_path = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "8170242" / "loh.hdf5"
    out_dir = root / "public" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    bin_path = out_dir / "pgv-loh-data.bin"
    manifest_path = out_dir / "pgv-loh-manifest.json"

    stride = 5  # 5000 -> 1000 scenarios for smaller payload
    grid_w, grid_h = 60, 60
    flat = grid_w * grid_h

    with h5py.File(h5_path, "r") as f:
        raw = f["data"][:]
        params = f["params"][:] if "params" in f else None

    # Subsample scenarios
    scenarios = raw[::stride, :].astype(np.float32)
    count = scenarios.shape[0]
    assert scenarios.shape[1] == flat

    global_max = float(np.max(np.abs(scenarios)))
    global_mean = float(np.mean(scenarios))

    scenarios.tofile(bin_path)

    manifest: dict = {
        "version": 1,
        "source": "loh.hdf5",
        "gridWidth": grid_w,
        "gridHeight": grid_h,
        "count": count,
        "stride": stride,
        "bytesPerSample": flat * 4,
        "globalMax": global_max,
        "globalMean": global_mean,
        "description": "Peak ground velocity (PGV) maps; scenario index is synthetic timeline.",
    }

    if params is not None:
        manifest["paramsNames"] = ["depth_km", "strike_deg", "dip_deg", "rake_deg"]
        manifest["paramsUnits"] = ["km", "deg", "deg", "deg"]
        manifest["paramsStride"] = params[::stride].tolist()

    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Wrote {bin_path} ({bin_path.stat().st_size} bytes)")
    print(f"Wrote {manifest_path}")
    print(f"scenarios={count}, global_max={global_max:.6g}")


if __name__ == "__main__":
    main()
