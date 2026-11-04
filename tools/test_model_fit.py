#!/usr/bin/env python3
"""Tests for tools/model_fit.py.  python3 tools/test_model_fit.py"""
import importlib.util, math, os, struct, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('mf', os.path.join(HERE, 'model_fit.py'))
mf = importlib.util.module_from_spec(spec); spec.loader.exec_module(mf)

PADS = (9.0, 19.0, 11.0, 21.0)  # 2 x 2 mm pad box at (10, 20)


def gltf(translation, rotation=(0, 0, 0, 1), lo=(-0.001, 0, -0.001), hi=(0.001, 0.001, 0.001)):
    """One footprint node "U1" with one child mesh (glTF metres, Y up)."""
    return {"scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"children": [1]},
                      {"name": "U1", "translation": list(translation), "rotation": list(rotation),
                       "children": [2]},
                      {"name": "=>[0:1:1:3]", "mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "accessors": [{"min": list(lo), "max": list(hi)}]}


class ModelBoxes(unittest.TestCase):
    def test_maps_gltf_to_board_axes(self):
        b = mf.model_boxes(gltf((0.010, 0.0016, 0.020)))["U1"]
        for got, want in zip(b, (9.0, 19.0, 1.6, 11.0, 21.0, 2.6)):
            self.assertAlmostEqual(got, want, places=6)

    def test_applies_node_rotation(self):
        s = math.sqrt(0.5)  # 90 deg about glTF Y (the board normal)
        b = mf.model_boxes(gltf((0, 0, 0), (0, s, 0, s), lo=(-0.003, 0, -0.001), hi=(0.003, 0.001, 0.001)))["U1"]
        self.assertAlmostEqual(b[3] - b[0], 2.0, places=6)
        self.assertAlmostEqual(b[4] - b[1], 6.0, places=6)

    def test_mesh_without_named_parent_is_ignored(self):
        g = gltf((0, 0, 0)); g["nodes"][1].pop("name")
        self.assertEqual(mf.model_boxes(g), {})


class PinBoxes(unittest.TestCase):
    def test_box_of_vertices_below_the_board(self):
        # 3 vertices in glTF metres; y is height. Two are pin tails (y < 0).
        pts = [(0.001, -0.003, 0.002), (0.004, -0.003, 0.002), (0.0, 0.010, 0.0)]
        blob = b"".join(struct.pack("<3f", *p) for p in pts)
        g = gltf((0.010, 0, 0.020))
        g["accessors"][0].update({"bufferView": 0, "componentType": 5126, "type": "VEC3", "count": 3})
        g["bufferViews"] = [{"buffer": 0, "byteOffset": 0, "byteLength": len(blob)}]
        b = mf.pin_boxes(g, blob)["U1"]
        for got, want in zip(b, (11.0, 22.0, 14.0, 22.0)):
            self.assertAlmostEqual(got, want, places=4)


class Assess(unittest.TestCase):
    def kinds(self, model, **kw):
        return [k for k, _ in mf.assess(model, PADS, 1.6, 0.3, **kw)]

    def test_good_fit_has_no_finding(self):
        self.assertEqual(self.kinds((8.8, 18.8, 1.6, 11.2, 21.2, 3.0)), [])

    def test_shifted_model_does_not_cover_pads(self):
        self.assertIn("cover", self.kinds((12.0, 18.8, 1.6, 14.4, 21.2, 3.0)))

    def test_floating_model(self):
        self.assertEqual(self.kinds((8.8, 18.8, 5.0, 11.2, 21.2, 7.0)), ["float"])

    def test_body_off_the_courtyard(self):
        k = [k for k, _ in mf.assess((8.8, 18.8, 1.6, 11.2, 30.0, 3.0), PADS, 1.6, 0.3,
                                    courtyard=(8.5, 12.0, 11.5, 23.0))]
        self.assertEqual(k, ["courtyard"])

    def test_body_on_the_courtyard(self):
        k = [k for k, _ in mf.assess((8.8, 18.8, 1.6, 11.2, 30.0, 3.0), PADS, 1.6, 0.3,
                                    courtyard=(8.5, 18.5, 11.5, 30.3))]
        self.assertEqual(k, [])

    def test_pin_tails_away_from_holes(self):
        k = [k for k, _ in mf.assess((8.8, 18.8, -3.0, 11.2, 21.2, 7.0), PADS, 1.6, 0.3,
                                    pins=(9.0, 22.0, 11.0, 24.0), holes=PADS)]
        self.assertEqual(k, ["pins"])

    def test_pin_tails_on_holes_are_fine(self):
        k = [k for k, _ in mf.assess((8.8, 18.8, -3.0, 11.2, 21.2, 7.0), PADS, 1.6, 0.3,
                                    pins=(8.9, 18.9, 11.1, 21.1), holes=PADS)]
        self.assertEqual(k, [])

    def test_smd_model_sunk_into_the_board(self):
        self.assertEqual(self.kinds((8.8, 18.8, 0.9, 11.2, 21.2, 2.1)), ["sink"])

    def test_tht_part_may_go_below_the_board_top(self):
        k = [k for k, _ in mf.assess((8.8, 18.8, 0.9, 11.2, 21.2, 7.0), PADS, 1.6, 0.3,
                                    pins=(8.9, 18.9, 11.1, 21.1), holes=PADS)]
        self.assertEqual(k, [])

    def test_pin_row_turned_90_degrees(self):
        holes = (5.0, 20.0, 15.0, 20.0)  # one row along x
        k = [k for k, _ in mf.assess((4.0, 15.0, -3.0, 16.0, 25.0, 7.0), holes, 1.6, 0.3,
                                    pins=(9.6, 14.6, 10.4, 25.4), holes=holes)]
        self.assertEqual(k, ["pins"])

    def test_pin_box_much_larger_than_the_holes_is_fine(self):
        # board locks of a D-sub are wider than its mounting holes
        k = [k for k, _ in mf.assess((4.0, 15.0, -3.0, 16.0, 25.0, 7.0), PADS, 1.6, 0.3,
                                    pins=(7.0, 18.6, 13.0, 21.4), holes=PADS)]
        self.assertEqual(k, [])

    def test_pin_box_a_little_larger_than_the_holes_is_fine(self):
        k = [k for k, _ in mf.assess((8.8, 18.8, -3.0, 11.2, 21.2, 7.0), PADS, 1.6, 0.3,
                                    pins=(8.4, 18.4, 11.6, 21.6), holes=PADS)]
        self.assertEqual(k, [])

    def test_missing_body_and_bad_file(self):
        self.assertEqual(self.kinds(None, files_ok=False), ["file", "missing"])

    def test_footprint_without_model_is_skipped(self):
        self.assertEqual(self.kinds(None, has_model=False), [])


class Resolve(unittest.TestCase):
    def test_project_and_kicad_variables(self):
        self.assertEqual(mf.resolve("${IOT_LAB}/a.step", "/b"), os.path.join(mf.ROOT, "a.step"))
        self.assertEqual(mf.resolve("${KIPRJMOD}/a.step", "/b"), "/b/a.step")
        self.assertEqual(mf.resolve("${KICAD10_3DMODEL_DIR}/R.3dshapes/r.step", "/b"),
                         os.path.join(mf.KICAD_3D, "R.3dshapes/r.step"))

    def test_unknown_variable_stays_unresolved(self):
        self.assertIn("${NOPE}", mf.resolve("${NOPE}/a.step", "/b"))


if __name__ == '__main__':
    unittest.main()
