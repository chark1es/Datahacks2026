# Dataset export

The game loads PGV data from `public/data/` generated from [`8170242/loh.hdf5`](../8170242/loh.hdf5).

## One-time setup

```bash
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install h5py numpy
```

## Generate assets

From the repo root:

```bash
python3 scripts/export_pgv.py
```

Optional custom HDF5 path:

```bash
python3 scripts/export_pgv.py /path/to/loh.hdf5
```

Outputs:

- `public/data/pgv-loh-data.bin` — raw `Float32`, row-major `count × (60×60)`
- `public/data/pgv-loh-manifest.json` — dimensions, `globalMax`, and `paramsStride` (`depth_km`, `strike_deg`, `dip_deg`, `rake_deg`)
