//! A whole board through the API, as `kicad::board::Board`.
use super::client::{ApiError, Client, decode};
use super::proto::kiapi::board::commands as bc;
use super::proto::kiapi::board::types as bt;
use super::proto::kiapi::board::{BoardStackupDielectricType, BoardStackupLayer as ApiStackupLayer, BoardStackupLayerType, board_stackup_layer};
use super::proto::kiapi::common::types as ct;
use crate::kicad::board::*;
use crate::kicad::geom::{Polygon, Pt, Rect, normalize_deg, outline};
use crate::kicad::pad::{Copper, Pad, PadForm, PadKind, PadShape, ZoneConnection, hole_box, mask_expansion};
use crate::kicad::shape::{Arc, Geometry, Graphic, radius};
use prost_types::Any;
use std::collections::BTreeMap;
use std::path::Path;

/// Everything of the board open on this server.
pub fn read_board(client: &mut Client, path: &Path) -> Result<Board, ApiError> {
    let doc = client.board_document()?;
    let copper_layers = copper_stack(client, &doc)?;
    let board_mask = board_mask_expansion(client, &doc)?;
    let mut footprints = Vec::new();
    for item in client.items(&doc, &[ct::KiCadObjectType::KotPcbFootprint])? {
        footprints.push(read_footprint(&open(&item)?, &copper_layers, board_mask)?);
    }
    let mut polygon_layers = copper_layers.clone();
    polygon_layers.extend(["F.Mask".to_string(), "B.Mask".to_string()]);
    set_pad_polygons(client, &doc, &polygon_layers, &mut footprints)?;
    let graphics = client.items(&doc, &[ct::KiCadObjectType::KotPcbShape])?.iter().filter_map(decode).map(|g: bt::BoardGraphicShape| read_graphic(&g)).collect::<Result<_, _>>()?;
    let zones = client.items(&doc, &[ct::KiCadObjectType::KotPcbZone])?.iter().filter_map(decode).map(|z: bt::Zone| read_zone(&z, &copper_layers)).collect::<Result<_, _>>()?;
    let texts = client.items(&doc, &[ct::KiCadObjectType::KotPcbText])?.iter().filter_map(decode).map(|t: bt::BoardText| read_text(&t)).collect();
    let groups = client.items(&doc, &[ct::KiCadObjectType::KotPcbGroup])?.iter().filter_map(decode).map(|g: bt::Group| read_group(&g)).collect();
    let mut board = Board {
        path: path.display().to_string(),
        stackup: read_stackup(client, &doc)?,
        nets: read_nets(client, &doc)?,
        copper: read_copper(client, &doc, &copper_layers)?,
        constraints: read_constraints(client, &doc)?,
        edges_bbox: edges_box(client, &doc)?,
        copper_layers,
        footprints,
        zones,
        graphics,
        texts,
        groups,
        outlines: Vec::new(),
    };
    board.outlines = outline::board_outlines(&board).unwrap_or_default();
    Ok(board)
}

fn board_mask_expansion(client: &mut Client, doc: &ct::DocumentSpecifier) -> Result<i64, ApiError> {
    let reply: bc::BoardDesignRulesResponse = client.call(&bc::GetBoardDesignRules { board: Some(doc.clone()) })?;
    Ok(reply.rules.and_then(|r| r.solder_mask_paste).map_or(0, |m| nm(&m.mask_expansion)))
}

fn read_constraints(client: &mut Client, doc: &ct::DocumentSpecifier) -> Result<Constraints, ApiError> {
    let reply: bc::BoardDesignRulesResponse = client.call(&bc::GetBoardDesignRules { board: Some(doc.clone()) })?;
    let rules = reply.rules.and_then(|r| r.constraints).ok_or_else(|| missing("board constraints"))?;
    Ok(Constraints {
        min_clearance: nm(&rules.min_clearance),
        min_track_width: nm(&rules.min_track_width),
        min_via_size: nm(&rules.min_via_size),
        copper_edge_clearance: nm(&rules.copper_edge_clearance),
    })
}

fn read_text(t: &bt::BoardText) -> Text {
    let text = t.text.as_ref();
    Text { id: id(&t.id), text: text.map_or(String::new(), |x| x.text.clone()), layer: layer_name(t.layer()), position: pt(&text.and_then(|x| x.position)) }
}

fn read_group(g: &bt::Group) -> Group {
    Group { id: id(&g.id), name: g.name.clone(), items: g.items.iter().map(|i| i.value.clone()).collect() }
}

/// KiCad's own polygon of each pad, a layer at a time. Ids that repeat stay out: the reply would be another pad's.
fn set_pad_polygons(client: &mut Client, doc: &ct::DocumentSpecifier, polygon_layers: &[String], footprints: &mut [Footprint]) -> Result<(), ApiError> {
    let mut uses: BTreeMap<String, usize> = BTreeMap::new();
    for pad in footprints.iter().flat_map(|f| &f.pads) {
        *uses.entry(pad.id.clone()).or_default() += 1;
    }
    for name in polygon_layers {
        let layer = bt::BoardLayer::from_str_name(&format!("BL_{}", name.replace('.', "_"))).ok_or_else(|| missing("layer"))?;
        let pads: Vec<ct::Kiid> = footprints.iter().flat_map(|f| &f.pads).filter(|p| uses[&p.id] == 1 && p.layers.contains(name)).map(|p| ct::Kiid { value: p.id.clone() }).collect();
        if pads.is_empty() { continue; }
        let reply: bc::PadShapeAsPolygonResponse = client.call(&bc::GetPadShapeAsPolygon { board: Some(doc.clone()), pads, layer: layer as i32 })?;
        let mut shapes: BTreeMap<String, Polygon> = BTreeMap::new();
        for (id, polygon) in reply.pads.iter().zip(&reply.polygons) {
            shapes.insert(id.value.clone(), read_polygon(polygon)?);
        }
        for pad in footprints.iter_mut().flat_map(|f| &mut f.pads) {
            if let Some(polygon) = shapes.remove(&pad.id) {
                pad.polygons.insert(name.clone(), polygon);
            }
        }
    }
    Ok(())
}

fn open<T: prost::Name + Default>(item: &Any) -> Result<T, ApiError> {
    decode(item).ok_or_else(|| ApiError::from(format!("expected {}, got {}", T::NAME, item.type_url)))
}

fn missing(what: &str) -> ApiError {
    ApiError::from(format!("KiCad sent no {what}"))
}

pub(super) fn pt(v: &Option<ct::Vector2>) -> Pt {
    v.as_ref().map_or(Pt::default(), |v| Pt::new(v.x_nm, v.y_nm))
}

pub(super) fn nm(d: &Option<ct::Distance>) -> i64 {
    d.as_ref().map_or(0, |d| d.value_nm)
}

fn deg(a: &Option<ct::Angle>) -> f64 {
    a.as_ref().map_or(0.0, |a| a.value_degrees)
}

fn id(k: &Option<ct::Kiid>) -> String {
    k.as_ref().map_or(String::new(), |k| k.value.clone())
}

pub(super) fn net(n: &Option<bt::Net>) -> String {
    n.as_ref().map_or(String::new(), |n| n.name.clone())
}

fn locked(state: ct::LockedState) -> bool {
    state == ct::LockedState::LsLocked
}

/// A layer's name: BL_In1_Cu is In1.Cu.
fn layer_name(layer: bt::BoardLayer) -> String {
    layer.as_str_name().trim_start_matches("BL_").replace('_', ".")
}

fn is_copper(layer: bt::BoardLayer) -> bool {
    layer.as_str_name().ends_with("_Cu")
}

/// The enum sorts F.Cu, In1.Cu ... In30.Cu, B.Cu: the stack order.
fn copper_stack(client: &mut Client, doc: &ct::DocumentSpecifier) -> Result<Vec<String>, ApiError> {
    let reply: bc::BoardEnabledLayersResponse = client.call(&bc::GetBoardEnabledLayers { board: Some(doc.clone()) })?;
    let mut copper: Vec<bt::BoardLayer> = reply.layers().filter(|l| is_copper(*l)).collect();
    copper.sort_by_key(|l| *l as i32);
    Ok(copper.into_iter().map(layer_name).collect())
}

fn read_nets(client: &mut Client, doc: &ct::DocumentSpecifier) -> Result<BTreeMap<String, String>, ApiError> {
    let nets = client.nets(doc)?;
    let reply: bc::NetClassForNetsResponse = client.call(&bc::GetNetClassForNets { net: nets })?;
    Ok(reply.classes.into_iter().filter(|(name, _)| !name.is_empty()).map(|(name, class)| (name, class.name)).collect())
}

fn read_stackup(client: &mut Client, doc: &ct::DocumentSpecifier) -> Result<Vec<StackupLayer>, ApiError> {
    let reply: bc::BoardStackupResponse = client.call(&bc::GetBoardStackup { board: Some(doc.clone()) })?;
    Ok(reply.stackup.ok_or_else(|| missing("stackup"))?.layers.iter().map(stackup_layer).collect())
}

fn stackup_layer(l: &ApiStackupLayer) -> StackupLayer {
    let name = if l.layer() == bt::BoardLayer::BlUndefined { String::new() } else { layer_name(l.layer()) };
    match (&l.details, l.r#type()) {
        (Some(board_stackup_layer::Details::Dielectric(d)), _) => StackupLayer {
            layer: name,
            kind: match d.r#type() {
                BoardStackupDielectricType::BsdtCore => StackupKind::Core,
                BoardStackupDielectricType::BsdtPrepreg => StackupKind::Prepreg,
                _ => StackupKind::Other,
            },
            thickness: d.layer.first().map_or(nm(&l.thickness), |s| nm(&s.thickness)),
        },
        (_, BoardStackupLayerType::BsltCopper) => StackupLayer { layer: name, kind: StackupKind::Copper, thickness: nm(&l.thickness) },
        _ => StackupLayer { layer: name, kind: StackupKind::Other, thickness: nm(&l.thickness) },
    }
}

fn edges_box(client: &mut Client, doc: &ct::DocumentSpecifier) -> Result<Rect, ApiError> {
    let reply: bc::BoardBoundingBoxResponse = client.call(&bc::GetBoardBoundingBox { board: Some(doc.clone()), mode: bc::BoardBoundingBoxMode::BbbmBoardEdgesOnly as i32 })?;
    box_of(reply.r#box.as_ref().ok_or_else(|| missing("board box"))?)
}

fn box_of(b: &ct::Box2) -> Result<Rect, ApiError> {
    let (at, size) = (pt(&b.position), pt(&b.size));
    Ok(Rect { left: at.x, top: at.y, right: at.x + size.x, bottom: at.y + size.y })
}

fn read_copper(client: &mut Client, doc: &ct::DocumentSpecifier, copper_layers: &[String]) -> Result<Vec<RoutedCopper>, ApiError> {
    use ct::KiCadObjectType::{KotPcbArc, KotPcbTrace, KotPcbVia};
    let items = client.items(doc, &[KotPcbTrace, KotPcbArc, KotPcbVia])?;
    items.iter().map(|item| routed_copper(item, copper_layers)).collect()
}

fn routed_copper(item: &Any, copper_layers: &[String]) -> Result<RoutedCopper, ApiError> {
    if let Some(t) = decode::<bt::Track>(item) {
        return Ok(RoutedCopper::Track(Track { id: id(&t.id), start: pt(&t.start), end: pt(&t.end), mid: None, width: nm(&t.width), layer: layer_name(t.layer()), net: net(&t.net), locked: locked(t.locked()) }));
    }
    if let Some(a) = decode::<bt::Arc>(item) {
        return Ok(RoutedCopper::Track(Track { id: id(&a.id), start: pt(&a.start), end: pt(&a.end), mid: Some(pt(&a.mid)), width: nm(&a.width), layer: layer_name(a.layer()), net: net(&a.net), locked: locked(a.locked()) }));
    }
    let v: bt::Via = open(item)?;
    let stack = v.pad_stack.as_ref().ok_or_else(|| missing("via stack"))?;
    let size = stack.copper_layers.first().map_or(Pt::default(), |l| pt(&l.size));
    let drill = stack.drill.as_ref().map_or(Pt::default(), |d| pt(&d.diameter));
    let on_via: Vec<String> = stack.layers().map(layer_name).collect();
    let layers = copper_layers.iter().filter(|l| on_via.contains(l)).cloned().collect();
    Ok(RoutedCopper::Via(Via { id: id(&v.id), at: pt(&v.position), size: size.x, drill: drill.x, net: net(&v.net), locked: locked(v.locked()), layers }))
}

fn field_text(f: &Option<bt::Field>) -> String {
    f.as_ref().and_then(|f| f.text.as_ref()).and_then(|t| t.text.as_ref()).map_or(String::new(), |t| t.text.clone())
}

fn read_footprint(f: &bt::FootprintInstance, copper_layers: &[String], board_mask: i64) -> Result<Footprint, ApiError> {
    let mask = |o: &Option<bt::SolderMaskOverrides>| o.as_ref().and_then(|m| m.solder_mask_margin.as_ref()).map(|d| d.value_nm);
    let footprint_mask = mask(&f.overrides.as_ref().and_then(|o| o.solder_mask.clone()));
    let definition = f.definition.as_ref().ok_or_else(|| missing("footprint definition"))?;
    let mut out = Footprint {
        id: id(&f.id),
        reference: field_text(&f.reference_field),
        value: field_text(&f.value_field),
        lib_id: definition.id.as_ref().map_or(String::new(), |l| format!("{}:{}", l.library_nickname, l.entry_name)),
        layer: layer_name(f.layer()),
        position: pt(&f.position),
        orientation: normalize_deg(deg(&f.orientation)),
        locked: locked(f.locked()),
        clearance_override: f.overrides.as_ref().and_then(|o| o.copper_clearance.as_ref()).map(|d| d.value_nm),
        fields: Vec::new(),
        pads: Vec::new(),
        graphics: Vec::new(),
        zones: Vec::new(),
        courtyard_front: Vec::new(),
        courtyard_back: Vec::new(),
    };
    for item in &definition.items {
        if let Some(p) = decode::<bt::Pad>(item) {
            let mut pad = read_pad(&p)?;
            let pad_mask = p.pad_stack.as_ref().and_then(|s| s.front_outer_layers.as_ref()).and_then(|l| mask(&l.solder_mask_settings));
            pad.solder_mask_expansion = if pad.layers.iter().any(|l| l.ends_with(".Cu")) { mask_expansion(pad_mask, footprint_mask, board_mask, pad.size) } else { 0 };
            out.pads.push(pad);
        } else if let Some(g) = decode::<bt::BoardGraphicShape>(item) {
            out.graphics.push(read_graphic(&g)?);
        } else if let Some(z) = decode::<bt::Zone>(item) {
            out.zones.push(read_zone(&z, copper_layers)?);
        } else if let Some(field) = decode::<bt::Field>(item) {
            let text = field_text(&Some(field.clone()));
            out.fields.push((field.name, text));
        }
    }
    out.courtyard_front = outline::courtyard(&out, false).unwrap_or_default();
    out.courtyard_back = outline::courtyard(&out, true).unwrap_or_default();
    Ok(out)
}

fn pad_kind(p: &bt::Pad) -> Result<PadKind, ApiError> {
    match p.r#type() {
        bt::PadType::PtPth => Ok(PadKind::ThroughHole),
        bt::PadType::PtSmd => Ok(PadKind::Smd),
        bt::PadType::PtEdgeConnector => Ok(PadKind::EdgeConnector),
        bt::PadType::PtNpth => Ok(PadKind::NpThroughHole),
        bt::PadType::PtUnknown => Err(missing("pad type")),
    }
}

fn pad_shape(shape: bt::PadStackShape) -> PadShape {
    match shape {
        bt::PadStackShape::PssCircle => PadShape::Circle,
        bt::PadStackShape::PssRectangle => PadShape::Rect,
        bt::PadStackShape::PssOval => PadShape::Oval,
        bt::PadStackShape::PssRoundrect => PadShape::RoundRect,
        bt::PadStackShape::PssCustom => PadShape::Custom,
        _ => PadShape::Other,
    }
}

fn zone_connection(style: bt::ZoneConnectionStyle) -> Option<ZoneConnection> {
    match style {
        bt::ZoneConnectionStyle::ZcsNone => Some(ZoneConnection::None),
        bt::ZoneConnectionStyle::ZcsThermal => Some(ZoneConnection::Thermal),
        bt::ZoneConnectionStyle::ZcsFull => Some(ZoneConnection::Full),
        bt::ZoneConnectionStyle::ZcsPthThermal => Some(ZoneConnection::ThtThermal),
        _ => None,
    }
}

fn read_pad(p: &bt::Pad) -> Result<Pad, ApiError> {
    let stack = p.pad_stack.as_ref().ok_or_else(|| missing("pad stack"))?;
    let layer = stack.copper_layers.first().ok_or_else(|| missing("pad copper layer"))?;
    if stack.r#type() != bt::PadStackType::PstNormal {
        return Err(ApiError::from(format!("pad {}: a pad stack per layer is not read", p.number)));
    }
    let orientation = normalize_deg(deg(&stack.angle));
    let (shape, position) = (pad_shape(layer.shape()), pt(&p.position));
    let form = PadForm { shape: anchor_or(shape, layer), center: position + pt(&layer.offset).rotated(orientation), orientation, size: pt(&layer.size), corner_ratio: layer.corner_rounding_ratio };
    let mut copper = form.copper();
    for primitive in layer.custom_shapes.iter().filter(|g| g.pad_custom_shape_options.is_none()) {
        copper.extend(primitive_copper(&read_graphic(primitive)?, &form));
    }
    let drill = stack.drill.as_ref();
    let drill_size = drill.map_or(Pt::default(), |d| pt(&d.diameter));
    let hole = hole_box(drill_size, drill.is_some_and(|d| d.shape() == bt::DrillShape::DsOblong), position, orientation);
    let bbox = copper.iter().map(Copper::bbox).fold(hole, Rect::merged);
    let settings = stack.zone_settings.as_ref();
    Ok(Pad {
        id: id(&p.id),
        number: p.number.clone(),
        kind: pad_kind(p)?,
        shape,
        net: net(&p.net),
        position,
        orientation,
        size: form.size,
        drill: drill_size,
        layers: stack.layers().map(layer_name).collect(),
        bbox,
        zone_connection: settings.and_then(|s| zone_connection(s.zone_connection())),
        thermal_spoke_angle: settings.and_then(|s| s.thermal_spokes.as_ref()).map_or(0.0, |t| deg(&t.angle)),
        spoke_templates: layer.custom_shapes.iter().filter(|g| is_spoke_template(g)).count(),
        copper,
        polygons: BTreeMap::new(),
        solder_mask_expansion: 0,
        clearance_override: p.copper_clearance_override.as_ref().map(|d| d.value_nm),
    })
}

fn anchor_or(shape: PadShape, layer: &bt::PadStackLayer) -> PadShape {
    match shape {
        PadShape::Custom => pad_shape(layer.custom_anchor_shape()),
        other => other,
    }
}

fn is_spoke_template(g: &bt::BoardGraphicShape) -> bool {
    use bt::pad_custom_shape_options::Role;
    matches!(g.pad_custom_shape_options.as_ref().and_then(|o| o.role), Some(Role::IsThermalSpokeTemplate(true)))
}

/// A custom pad primitive, in coordinates of the pad, as PCB_SHAPE::MakeEffectiveShapes.
fn primitive_copper(g: &Graphic, form: &PadForm) -> Vec<Copper> {
    let map = |p: Pt| p.rotated(form.orientation) + form.center;
    let ring = |points: &[Pt]| -> Vec<Copper> {
        let mapped: Vec<Pt> = points.iter().copied().map(map).collect();
        let solid = g.filled.then(|| Copper::Polygon(mapped.clone()));
        let edges = (g.width > 0 || !g.filled).then_some(0..mapped.len()).into_iter().flatten();
        solid.into_iter().chain(edges.map(|i| Copper::Segment { a: mapped[i], b: mapped[(i + 1) % mapped.len()], width: g.width })).collect()
    };
    match &g.geometry {
        Geometry::Poly { rings } => rings.iter().flat_map(|r| ring(r)).collect(),
        Geometry::Rect { top_left, bottom_right } => ring(&[*top_left, Pt::new(bottom_right.x, top_left.y), *bottom_right, Pt::new(top_left.x, bottom_right.y)]),
        Geometry::Segment { start, end } => vec![Copper::Segment { a: map(*start), b: map(*end), width: g.width }],
        Geometry::Circle { center, radius_point } => vec![Copper::Circle { center: map(*center), radius: radius(*center, *radius_point) + g.width / 2 }],
        Geometry::Arc(_) | Geometry::Other => Vec::new(),
    }
}

fn read_ring(line: &Option<ct::PolyLine>) -> Result<Vec<Pt>, ApiError> {
    use ct::poly_line_node::Geometry as Node;
    let nodes = line.as_ref().map_or(&[][..], |l| &l.nodes);
    nodes.iter().map(|n| match &n.geometry {
        Some(Node::Point(p)) => Ok(Pt::new(p.x_nm, p.y_nm)),
        _ => Err(ApiError::from("a polygon with an arc is not read".to_string())),
    }).collect()
}

fn read_polygon(p: &ct::PolygonWithHoles) -> Result<Polygon, ApiError> {
    Ok(Polygon { outline: read_ring(&p.outline)?, holes: p.holes.iter().map(|h| read_ring(&Some(h.clone()))).collect::<Result<_, _>>()? })
}

fn read_polygons(set: &Option<ct::PolySet>) -> Result<Vec<Polygon>, ApiError> {
    set.as_ref().map_or(&[][..], |s| &s.polygons).iter().map(read_polygon).collect()
}

fn read_graphic(g: &bt::BoardGraphicShape) -> Result<Graphic, ApiError> {
    use ct::graphic_shape::Geometry as Shape;
    let shape = g.shape.as_ref().ok_or_else(|| missing("graphic shape"))?;
    let attrs = shape.attributes.as_ref();
    let geometry = match &shape.geometry {
        Some(Shape::Segment(s)) => Geometry::Segment { start: pt(&s.start), end: pt(&s.end) },
        Some(Shape::Rectangle(r)) => Geometry::Rect { top_left: pt(&r.top_left), bottom_right: pt(&r.bottom_right) },
        Some(Shape::Arc(a)) => Geometry::Arc(Arc::through(pt(&a.start), pt(&a.mid), pt(&a.end))),
        Some(Shape::Circle(c)) => Geometry::Circle { center: pt(&c.center), radius_point: pt(&c.radius_point) },
        Some(Shape::Polygon(p)) => Geometry::Poly { rings: read_polygons(&Some(p.clone()))?.into_iter().map(|p| p.outline).collect() },
        _ => Geometry::Other,
    };
    Ok(Graphic {
        id: id(&g.id),
        geometry,
        layer: layer_name(g.layer()),
        width: attrs.and_then(|a| a.stroke.as_ref()).map_or(0, |s| nm(&s.width)),
        filled: attrs.and_then(|a| a.fill.as_ref()).is_some_and(|f| f.fill_type() != ct::GraphicFillType::GftUnfilled),
    })
}

fn read_zone(z: &bt::Zone, copper_layers: &[String]) -> Result<Zone, ApiError> {
    use bt::zone::Settings;
    let on_zone: Vec<String> = z.layers().map(layer_name).collect();
    let (copper, area) = match &z.settings {
        Some(Settings::CopperSettings(c)) => (Some(c), None),
        Some(Settings::RuleAreaSettings(r)) => (None, Some(RuleArea { tracks: r.keepout_tracks, vias: r.keepout_vias, pour: r.keepout_copper, pads: r.keepout_pads, footprints: r.keepout_footprints })),
        None => (None, None),
    };
    let filled = z.filled_polygons.iter().map(|f| Ok(FilledLayer { layer: layer_name(f.layer()), polygons: read_polygons(&f.shapes)? })).collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Zone {
        id: id(&z.id),
        name: z.name.clone(),
        net: copper.map_or(String::new(), |c| net(&c.net)),
        layers: copper_layers.iter().filter(|l| on_zone.contains(l)).cloned().collect(),
        outline: read_polygons(&z.outline)?,
        filled,
        rule_area: area,
        fill: copper.map(|c| zone_fill(c, z.priority)),
    })
}

fn zone_fill(c: &bt::CopperZoneSettings, priority: u32) -> ZoneFill {
    let connection = c.connection.as_ref();
    let spokes = connection.and_then(|s| s.thermal_spokes.as_ref());
    ZoneFill {
        clearance: nm(&c.clearance),
        priority,
        min_thickness: nm(&c.min_thickness),
        corner_smoothing: c.corner_smoothing,
        corner_radius: nm(&c.corner_radius),
        thermal_gap: spokes.map_or(0, |s| nm(&s.gap)),
        spoke_width: spokes.map_or(0, |s| nm(&s.width)),
        pad_connection: connection.and_then(|s| zone_connection(s.zone_connection())),
        island_removal_mode: match c.island_mode() {
            bt::IslandRemovalMode::IrmNever => 1,
            bt::IslandRemovalMode::IrmArea => 2,
            _ => 0,
        },
        min_island_area: c.min_island_area,
    }
}
