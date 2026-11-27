"""Measure and reposition complete native edge rings relative to supplied joints."""

import numpy as np


def support_rings(points, edges, frame):
    origin, axis, length = frame
    delta = (points - origin) / length
    along = delta @ axis
    radial = delta - along[:, None] * axis
    nearby = (abs(along) < 0.52) & (np.linalg.norm(radial, axis=1) < 0.57)
    a, b = edges[nearby[edges].all(axis=1)].T
    transverse = abs(along[a] - along[b]) < 0.55 * np.linalg.norm(
        delta[a] - delta[b], axis=1
    )
    neighbors = {}
    for u, v in zip(a[transverse], b[transverse]):
        neighbors.setdefault(u, []).append(v)
        neighbors.setdefault(v, []).append(u)
    rings = []
    seen = set()
    for start in neighbors:
        if start in seen:
            continue
        todo, component = [start], []
        while todo:
            u = todo.pop()
            if u not in seen:
                seen.add(u)
                component.append(u)
                todo.extend(neighbors[u])
        if len(component) < 4 or any(len(neighbors[u]) != 2 for u in component):
            continue
        # A peripheral closed patch must not count as a ring around this bone.
        ids = [start]
        prev, u = start, neighbors[start][0]
        while u != start:
            ids.append(u)
            v, w = neighbors[u]
            prev, u = u, w if v == prev else v
        r = radial[ids]
        following = np.roll(r, -1, axis=0)
        winding = np.arctan2(
            np.cross(r, following) @ axis, (r * following).sum(axis=1)
        ).sum()
        if abs(winding) > np.pi:
            rings.append((float(along[ids].mean()), ids))
    return sorted(rings)


def measure(points, faces, frames):
    edges = np.unique(
        np.sort(
            np.stack([faces, np.roll(faces, -1, axis=1)], axis=-1).reshape(-1, 2),
            axis=1,
        ),
        axis=0,
    )
    return {name: support_rings(points, edges, frame) for name, frame in frames.items()}


def supports(rings):
    # Nearest complete circumferential support on each side of the joint center.
    return [
        max((r for r in rings if r[0] < 0), default=None),
        min((r for r in rings if r[0] >= 0), default=None),
    ]


def inspect(points, faces, frames, rules):
    measured = measure(points, faces, frames)
    errors, moves, details = {}, {}, {}
    for name, rings in measured.items():
        origin, axis, length = frames[name]
        details[name] = []
        for label, wanted, actual in zip(
            ("proximal", "distal"), rules[name], supports(rings)
        ):
            entry = {
                "side": label,
                "reference": wanted,
                "measured": actual[0] if actual else None,
            }
            details[name].append(entry)
            if wanted is None or actual is None:
                continue
            error = wanted - actual[0]
            key = (name, label)
            errors[key] = abs(error)
            moves[key] = (actual[1], axis * length * error)
    return errors, moves, details


def normals(p, f):
    tri = np.concatenate([f[:, [0, 1, 2]], f[:, [0, 2, 3]]])
    return np.cross(p[tri[:, 1]] - p[tri[:, 0]], p[tri[:, 2]] - p[tri[:, 0]])


def prepare(points, faces, selection, landmarks):
    if not selection or len(selection) > 5000 or len(landmarks) > 30 or not landmarks:
        raise ValueError("Expected 1-5000 patch faces and 1-30 joint landmarks")
    if len(set(selection)) != len(selection) or any(
        type(i) != int or not 0 <= i < len(faces) for i in selection
    ):
        raise ValueError("Invalid selected faces")
    if any(len(faces[i]) != 4 for i in selection):
        raise ValueError("Joint-ring measurement requires native quads")
    patch = np.array([faces[i] for i in selection])
    ids, local = np.unique(patch, return_inverse=True)
    frames = {}
    for name, chain in landmarks.items():
        chain = np.asarray(chain, dtype=float)
        if chain.shape != (3, 3) or not np.isfinite(chain).all():
            raise ValueError(
                "Each landmark needs previous, center and next XYZ in mesh units"
            )
        a, b, c = chain
        axis = c - a
        length = min(np.linalg.norm(c - b), np.linalg.norm(b - a))
        if length <= 0 or np.linalg.norm(axis) == 0:
            raise ValueError("Degenerate joint frame")
        frames[name] = (b, axis / np.linalg.norm(axis), length)
    return ids, points[ids], local.reshape(-1, 4), frames


def repair(job, base, out, read_obj, sha):
    inputs = []
    for key in ("reference", "target"):
        spec = job[key]
        path = base / spec["file"]
        if sha(path) != spec["sha256"]:
            raise ValueError(key + " hash mismatch")
        if ("group" in spec) == ("faces" in spec):
            raise ValueError("Select a named face group or explicit faces")
        vertices, faces, group = read_obj(path, spec.get("group"))
        selection = spec.get("faces", group)
        ids, points, polys, frames = prepare(vertices, faces, selection, spec["joints"])
        inputs.append((points, polys, frames))
    (ref, rf, rj), (p, f, frames) = inputs
    if frames.keys() != rj.keys():
        raise ValueError("Corresponding joint names must match")
    rules = {
        k: [r[0] if r else None for r in supports(v)]
        for k, v in measure(ref, rf, rj).items()
    }
    baseline = p.copy()
    n0 = normals(p, f)
    if np.any((n0 * n0).sum(1) == 0):
        raise ValueError("Degenerate input triangle")
    selection = set(selection)
    locked = set(
        np.flatnonzero(
            np.isin(
                ids,
                [v for i, face in enumerate(faces) if i not in selection for v in face],
            )
        )
    )
    limit = job["maxVertexDisplacement"]
    if type(limit) not in (float, int) or not np.isfinite(limit) or limit <= 0:
        raise ValueError("Expected positive displacement limit in mesh units")
    errors, moves, before = inspect(p, f, frames, rules)
    if not errors:
        raise ValueError("No matching measurable joint supports")
    history = []
    for iteration in range(6):
        accepted = False
        for key in sorted(errors, key=errors.get, reverse=True):
            indices, shift = moves[key]
            if errors[key] < 0.005 or locked.intersection(indices):
                continue
            for factor in (0.5, 0.25, 0.125):
                trial = p.copy()
                trial[indices] += factor * shift
                if np.linalg.norm(trial - baseline, axis=1).max() > limit:
                    continue
                if np.any(
                    (normals(trial, f) * n0).sum(1)
                    < 0.5 * (n0 ** 2).sum(1)
                ):
                    continue
                e, m, _ = inspect(trial, f, frames, rules)
                if (
                    e.keys() == errors.keys()
                    and e[key] < errors[key] - 1e-5
                    and all(e[k] <= errors[k] + 1e-8 for k in errors)
                ):
                    history.append([iteration + 1, *key, errors[key], e[key]])
                    errors, moves, p = e, m, trial
                    accepted = True
                    break
        if not accepted:
            break
    delta = np.linalg.norm(p - baseline, axis=1)
    moved = delta[delta > 1e-9]
    vertices[ids] = p
    path = out / "candidate.obj"
    with path.open("x") as stream:
        for xyz in vertices:
            print("v", *xyz.tolist(), file=stream)
        for face in faces:
            print("f", *[v + 1 for v in face], file=stream)
    q, g, _ = read_obj(path)
    if g != faces or not np.array_equal(q, vertices):
        raise ValueError("Geometry changed on reload")
    checked, _, after = inspect(q[ids], f, frames, rules)
    if checked != errors:
        raise ValueError("Joint measurements changed on reload")
    return dict(
        method="joint_ring_spacing",
        region=job["region"],
        units=job["units"],
        comparable=len(errors),
        requested=2 * len(frames),
        before=before,
        after=after,
        acceptedEdits=history,
        vertexCount=len(ids),
        movedVertices=len(moved),
        medianMoved=float(np.median(moved)) if moved.size else 0,
        maxMoved=float(delta.max()),
        maxVertexDisplacement=limit,
        vertexWithinTolerance=bool(delta.max() <= limit),
        referenceSha256=job["reference"]["sha256"],
        targetSha256=job["target"]["sha256"],
        candidateSha256=sha(path),
        status="needs_review",
        handoffAllowed=False,
    )
