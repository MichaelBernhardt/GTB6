"""Export the committed web GLB from the generated Blender tree source."""

import argparse
import sys
from pathlib import Path

import bpy


values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
args = parser.parse_args(values)

root = bpy.data.objects.get("JohannesburgTreeLibrary")
if root is None or root.get("treeContract", {}).get("version") != 1:
    raise RuntimeError("Tree source is missing the JohannesburgTreeLibrary v1 contract")

output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(output),
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_extras=True,
    export_animations=False,
    export_skins=False,
    export_materials="EXPORT",
    export_image_format="AUTO",
    export_cameras=False,
    export_lights=False,
)
print(f"Exported tree library: {output}")
