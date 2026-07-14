/* AzADServicePrincipalInsights - interactive Permission Map
   Self-contained force-directed graph on <canvas>. No external libraries.
   Data contract: <script id="azadspiMapData" type="application/json"> { nodes, edges, stats } </script>
   Node: { id, t, l, sub, r, m }   Edge: { s, d, k, l, r } */
(function () {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* configuration                                                       */
    /* ------------------------------------------------------------------ */
    var TYPE_CONFIG = {
        app: { label: 'App / Service Principal', colorVar: '--map-app', shape: 'square', baseRadius: 9 },
        appExt: { label: 'External / multi-tenant SP', colorVar: '--map-appext', shape: 'square', baseRadius: 9 },
        mi: { label: 'Managed identity', colorVar: '--map-mi', shape: 'diamond', baseRadius: 8 },
        user: { label: 'User', colorVar: '--map-user', shape: 'circle', baseRadius: 6 },
        guest: { label: 'Guest user', colorVar: '--map-guest', shape: 'circle', baseRadius: 6 },
        group: { label: 'Group', colorVar: '--map-group', shape: 'hex', baseRadius: 7 },
        resource: { label: 'Resource API', colorVar: '--map-resource', shape: 'squareOutline', baseRadius: 10 },
        permApp: { label: 'Application permission', colorVar: '--map-perm-none', shape: 'dot', baseRadius: 4.5 },
        permDel: { label: 'Delegated permission', colorVar: '--map-perm-none', shape: 'ring', baseRadius: 4.5 },
        role: { label: 'Entra directory role', colorVar: '--map-role', shape: 'star', baseRadius: 7 }
    };

    var FILTER_GROUPS = [
        { key: 'apps', label: 'Apps', types: ['app', 'appExt'], colorVar: '--map-app', shape: 'square' },
        { key: 'mi', label: 'Managed identities', types: ['mi'], colorVar: '--map-mi', shape: 'square' },
        { key: 'users', label: 'Users', types: ['user', 'guest'], colorVar: '--map-user', shape: 'circle' },
        { key: 'groups', label: 'Groups', types: ['group'], colorVar: '--map-group', shape: 'square' },
        { key: 'resources', label: 'Resource APIs', types: ['resource'], colorVar: '--map-resource', shape: 'square' },
        { key: 'perms', label: 'Permissions', types: ['permApp', 'permDel'], colorVar: '--map-perm-critical', shape: 'circle' },
        { key: 'roles', label: 'Directory roles', types: ['role'], colorVar: '--map-role', shape: 'square' }
    ];

    var RISK_CHIPS = [
        { key: 'critical', label: 'Critical', colorVar: '--map-perm-critical' },
        { key: 'medium', label: 'Medium', colorVar: '--map-perm-medium' },
        { key: 'none', label: 'Unclassified', colorVar: '--map-perm-none' }
    ];

    var EDGE_KIND_LABEL = {
        owns: 'owner of',
        permApp: 'application permission',
        permDel: 'delegated permission',
        onApi: 'permission on API',
        usesApi: 'uses API (unclassified permissions)',
        assignedTo: 'assigned to app',
        memberOf: 'member of',
        aadRole: 'directory role'
    };

    var LINK_DISTANCE = {
        owns: 62, permApp: 48, permDel: 48, onApi: 55, usesApi: 95,
        assignedTo: 72, memberOf: 70, aadRole: 60
    };

    var META_LABELS = {
        objectId: 'Object ID', appId: 'App (client) ID', objectType: 'Type', spType: 'SP type',
        accountEnabled: 'Enabled', createdDateTime: 'Created', orgId: 'Owner org', signInAudience: 'Sign-in audience',
        secretCount: 'Secrets', certCount: 'Certificates', federatedCredentialCount: 'Federated credentials',
        azureRoleCount: 'Azure role assignments', assignedToCount: 'Assigned principals',
        spOwnerCount: 'SP owners', appOwnerCount: 'App owners', principalType: 'Principal type',
        miResourceType: 'MI resource type', miResourceScope: 'MI resource scope',
        resource: 'Resource API', displayName: 'Display name', description: 'Description',
        classification: 'Classification', roleType: 'Role type', roleDefinitionId: 'Role definition ID'
    };

    /* ------------------------------------------------------------------ */
    /* state                                                               */
    /* ------------------------------------------------------------------ */
    var nodes = [], edges = [], nodeById = {}, adjacency = {};
    var canvas, ctx, tooltipEl, detailsEl, stageEl, sectionEl;
    var width = 0, height = 0, dpr = 1;
    var view = { x: 0, y: 0, k: 1 };
    var alpha = 0, alphaTarget = 0;
    var hoveredNode = null, selectedNode = null, neighborSet = null;
    var draggingNode = null, panning = false, pointerDownPos = null, moved = false;
    var typeFilter = {}, riskFilter = { critical: true, medium: true, none: true };
    var colors = {}, inkColors = {};
    var rafPending = false, simRunning = false;
    var searchIndex = [];
    var didInitialFit = false, tickCount = 0;
    var labelBudget = 350;
    var labelOrder = [];
    var userAdjustedView = false;

    /* deterministic RNG so the layout is stable between reloads */
    function mulberry32(seed) {
        return function () {
            seed |= 0; seed = seed + 0x6D2B79F5 | 0;
            var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    /* ------------------------------------------------------------------ */
    /* colors from CSS custom properties (theme aware)                     */
    /* ------------------------------------------------------------------ */
    function resolveColors() {
        var styles = getComputedStyle(document.documentElement);
        function v(name, fallback) {
            var val = styles.getPropertyValue(name).trim();
            return val || fallback;
        }
        Object.keys(TYPE_CONFIG).forEach(function (t) {
            colors[t] = v(TYPE_CONFIG[t].colorVar, '#888888');
        });
        colors.permCritical = v('--map-perm-critical', '#d03b3b');
        colors.permMedium = v('--map-perm-medium', '#fab219');
        colors.permNone = v('--map-perm-none', '#898781');
        colors.edge = v('--map-edge', '#cccccc');
        colors.edgeDim = v('--map-edge-dim', 'rgba(136,136,136,0.15)');
        colors.halo = v('--map-halo', 'rgba(42,120,214,0.25)');
        colors.surface = v('--bg-surface', '#ffffff');
        inkColors.primary = v('--ink', '#0b0b0b');
        inkColors.secondary = v('--ink-2', '#52514e');
        inkColors.muted = v('--ink-3', '#898781');
    }

    function nodeColor(node) {
        if (node.t === 'permApp' || node.t === 'permDel') {
            if (node.r === 'critical') { return colors.permCritical; }
            if (node.r === 'medium') { return colors.permMedium; }
            return colors.permNone;
        }
        return colors[node.t] || colors.permNone;
    }

    /* ------------------------------------------------------------------ */
    /* data preparation                                                    */
    /* ------------------------------------------------------------------ */
    function prepare(data) {
        var rand = mulberry32(1337);
        nodes = data.nodes || [];
        edges = data.edges || [];
        nodeById = {};
        adjacency = {};

        nodes.forEach(function (n) {
            nodeById[n.id] = n;
            n.degree = 0;
            n.visible = true;
            adjacency[n.id] = [];
        });

        edges = edges.filter(function (e) {
            var sn = nodeById[e.s], dn = nodeById[e.d];
            if (!sn || !dn) { return false; }
            e.sn = sn; e.dn = dn;
            sn.degree++; dn.degree++;
            adjacency[e.s].push({ node: dn, edge: e, out: true });
            adjacency[e.d].push({ node: sn, edge: e, out: false });
            return true;
        });

        /* cluster-seeded initial positions: each type starts in its own zone */
        var clusterAngle = {
            app: -2.2, appExt: -1.2, mi: -2.9, resource: 0, permApp: -0.5, permDel: 0.5,
            user: 2.4, guest: 2.0, group: 1.5, role: 3.0
        };
        var spread = Math.max(240, Math.sqrt(nodes.length) * 26);
        nodes.forEach(function (n) {
            var angle = (clusterAngle[n.t] !== undefined ? clusterAngle[n.t] : rand() * Math.PI * 2);
            var dist = spread * (0.35 + rand() * 0.65);
            n.x = Math.cos(angle) * dist + (rand() - 0.5) * spread * 0.5;
            n.y = Math.sin(angle) * dist + (rand() - 0.5) * spread * 0.5;
            n.vx = 0; n.vy = 0;
            var cfg = TYPE_CONFIG[n.t] || TYPE_CONFIG.app;
            n.radius = Math.min(26, cfg.baseRadius * (0.85 + Math.sqrt(n.degree) / 5));
        });

        searchIndex = nodes.map(function (n) {
            var hay = (n.l || '') + ' ' + (n.sub || '');
            if (n.m) {
                if (n.m.appId) { hay += ' ' + n.m.appId; }
                if (n.m.objectId) { hay += ' ' + n.m.objectId; }
            }
            return { node: n, hay: hay.toLowerCase() };
        });

        FILTER_GROUPS.forEach(function (g) { typeFilter[g.key] = true; });
        labelBudget = nodes.length > 2500 ? 200 : 350;
        labelOrder = nodes.slice().sort(function (a, b) { return b.degree - a.degree; });
    }

    function nodeFilterGroup(node) {
        for (var i = 0; i < FILTER_GROUPS.length; i++) {
            if (FILTER_GROUPS[i].types.indexOf(node.t) !== -1) { return FILTER_GROUPS[i].key; }
        }
        return null;
    }

    function applyFilters() {
        nodes.forEach(function (n) {
            var groupKey = nodeFilterGroup(n);
            var vis = groupKey ? typeFilter[groupKey] : true;
            if (vis && (n.t === 'permApp' || n.t === 'permDel' || n.t === 'role')) {
                var riskKey = n.r === 'critical' ? 'critical' : (n.r === 'medium' ? 'medium' : 'none');
                vis = riskFilter[riskKey];
            }
            n.visible = vis;
        });
        edges.forEach(function (e) { e.visible = e.sn.visible && e.dn.visible; });
        if (selectedNode && !selectedNode.visible) { select(null); }
        if (hoveredNode && !hoveredNode.visible) { hoveredNode = null; hideTooltip(); }
        reheat(0.35);
    }

    /* ------------------------------------------------------------------ */
    /* force simulation                                                    */
    /* ------------------------------------------------------------------ */
    function reheat(target) {
        alpha = Math.max(alpha, target === undefined ? 0.9 : target);
        if (!simRunning) { simRunning = true; }
        scheduleFrame();
    }

    function simTick() {
        var i, n, e;
        var visibleNodes = [];
        for (i = 0; i < nodes.length; i++) { if (nodes[i].visible) { visibleNodes.push(nodes[i]); } }
        if (!visibleNodes.length) { return; }

        /* link springs */
        for (i = 0; i < edges.length; i++) {
            e = edges[i];
            if (!e.visible) { continue; }
            var dx = e.dn.x - e.sn.x, dy = e.dn.y - e.sn.y;
            var dist = Math.sqrt(dx * dx + dy * dy) || 1;
            var target = (LINK_DISTANCE[e.k] || 65) + e.sn.radius + e.dn.radius;
            var strength = 0.11 / Math.max(1, Math.sqrt(Math.min(e.sn.degree, e.dn.degree)) * 0.6);
            var f = (dist - target) * strength * alpha;
            var fx = dx / dist * f, fy = dy / dist * f;
            e.sn.vx += fx; e.sn.vy += fy;
            e.dn.vx -= fx; e.dn.vy -= fy;
        }

        /* many-body repulsion via uniform grid (one-level Barnes-Hut) */
        var cell = 140;
        var grid = {};
        for (i = 0; i < visibleNodes.length; i++) {
            n = visibleNodes[i];
            var key = Math.floor(n.x / cell) + '_' + Math.floor(n.y / cell);
            var g = grid[key];
            if (!g) { g = grid[key] = { x: 0, y: 0, mass: 0, items: [] }; }
            g.x += n.x; g.y += n.y; g.mass++;
            g.items.push(n);
        }
        var cellKeys = Object.keys(grid);
        var aggregates = [];
        for (i = 0; i < cellKeys.length; i++) {
            var cg = grid[cellKeys[i]];
            var parts = cellKeys[i].split('_');
            aggregates.push({
                cx: cg.x / cg.mass, cy: cg.y / cg.mass, mass: cg.mass,
                gx: parseInt(parts[0], 10), gy: parseInt(parts[1], 10), items: cg.items
            });
        }
        var repulsion = -520 * alpha;
        for (i = 0; i < visibleNodes.length; i++) {
            n = visibleNodes[i];
            var ngx = Math.floor(n.x / cell), ngy = Math.floor(n.y / cell);
            for (var a = 0; a < aggregates.length; a++) {
                var agg = aggregates[a];
                var near = Math.abs(agg.gx - ngx) <= 1 && Math.abs(agg.gy - ngy) <= 1;
                if (near) {
                    for (var j = 0; j < agg.items.length; j++) {
                        var other = agg.items[j];
                        if (other === n) { continue; }
                        var rdx = n.x - other.x, rdy = n.y - other.y;
                        var d2 = rdx * rdx + rdy * rdy;
                        if (d2 < 1) { d2 = 1; rdx = (Math.random() - 0.5); rdy = (Math.random() - 0.5); }
                        if (d2 > cell * cell * 4) { continue; }
                        var inv = repulsion / d2;
                        n.vx -= rdx * inv; n.vy -= rdy * inv;
                    }
                }
                else {
                    var adx = n.x - agg.cx, ady = n.y - agg.cy;
                    var ad2 = adx * adx + ady * ady;
                    if (ad2 < 1) { ad2 = 1; }
                    var ainv = repulsion * agg.mass / ad2;
                    n.vx -= adx * ainv; n.vy -= ady * ainv;
                }
            }
        }

        /* gentle centering + integration */
        for (i = 0; i < visibleNodes.length; i++) {
            n = visibleNodes[i];
            n.vx -= n.x * 0.024 * alpha;
            n.vy -= n.y * 0.024 * alpha;
            if (n === draggingNode) { n.vx = 0; n.vy = 0; continue; }
            n.vx *= 0.6; n.vy *= 0.6;
            var vmax = 10;
            if (n.vx > vmax) { n.vx = vmax; } else if (n.vx < -vmax) { n.vx = -vmax; }
            if (n.vy > vmax) { n.vy = vmax; } else if (n.vy < -vmax) { n.vy = -vmax; }
            n.x += n.vx;
            n.y += n.vy;
        }

        alpha += (alphaTarget - alpha) * 0.028;
        tickCount++;
        if (!didInitialFit && (tickCount === 90 || alpha < 0.12)) {
            didInitialFit = true;
            fitToView();
        }
        if (alpha < 0.005) {
            alpha = 0;
            simRunning = false;
            if (!userAdjustedView) { fitToView(); }
        }
    }

    /* ------------------------------------------------------------------ */
    /* rendering                                                           */
    /* ------------------------------------------------------------------ */
    function scheduleFrame() {
        if (rafPending) { return; }
        rafPending = true;
        requestAnimationFrame(frame);
    }

    function frame() {
        rafPending = false;
        if (simRunning) {
            var steps = nodes.length > 2500 ? 1 : 2;
            for (var s = 0; s < steps && simRunning; s++) { simTick(); }
        }
        draw();
        if (simRunning) { scheduleFrame(); }
    }

    function draw() {
        if (!ctx) { return; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.translate(view.x, view.y);
        ctx.scale(view.k, view.k);

        var hasSelection = !!selectedNode;
        var i, e, n;

        /* edges */
        ctx.lineWidth = Math.max(0.4, 1 / view.k);
        for (i = 0; i < edges.length; i++) {
            e = edges[i];
            if (!e.visible) { continue; }
            var inFocus = !hasSelection || (neighborSet && neighborSet[e.sn.id] && neighborSet[e.dn.id] && (e.sn === selectedNode || e.dn === selectedNode));
            if (hasSelection && !inFocus) {
                ctx.strokeStyle = colors.edgeDim;
            }
            else if (e.r === 'critical') {
                ctx.strokeStyle = colors.permCritical;
                ctx.lineWidth = Math.max(0.8, 1.6 / view.k);
            }
            else if (e.r === 'medium') {
                ctx.strokeStyle = colors.permMedium;
                ctx.lineWidth = Math.max(0.7, 1.3 / view.k);
            }
            else {
                ctx.strokeStyle = colors.edge;
                ctx.lineWidth = Math.max(0.4, 1 / view.k);
            }
            if (hasSelection && inFocus && e.sn !== selectedNode && e.dn !== selectedNode) {
                ctx.strokeStyle = colors.edgeDim;
            }
            ctx.beginPath();
            ctx.moveTo(e.sn.x, e.sn.y);
            ctx.lineTo(e.dn.x, e.dn.y);
            ctx.stroke();
        }

        /* nodes */
        for (i = 0; i < nodes.length; i++) {
            n = nodes[i];
            if (!n.visible) { continue; }
            var dimmed = hasSelection && !(neighborSet && neighborSet[n.id]);
            drawNode(n, dimmed);
        }

        /* labels (screen-size independent of zoom) */
        var labelsDrawn = 0;
        var fontPx = 11.5 / view.k;
        ctx.font = '500 ' + fontPx + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        var minDegreeForLabel = nodes.length > 800 ? 6 : 2;
        var drawnLabelRects = [];
        for (i = 0; i < labelOrder.length && labelsDrawn < labelBudget; i++) {
            n = labelOrder[i];
            if (!n.visible) { continue; }
            var isFocus = n === hoveredNode || n === selectedNode || (hasSelection && neighborSet && neighborSet[n.id]);
            if (!isFocus && n.radius * view.k < 8.5 && n.degree < minDegreeForLabel) { continue; }
            if (hasSelection && !isFocus) { continue; }
            var text = n.l || '';
            if (text.length > 28) { text = text.slice(0, 27) + '…'; }
            /* declutter: high-degree labels win, overlapping lower-priority labels are skipped */
            var tw = ctx.measureText(text).width;
            var lx = n.x - tw / 2, ly = n.y + n.radius + 3 / view.k, lh = fontPx * 1.25;
            var collides = false;
            if (!isFocus) {
                for (var q = 0; q < drawnLabelRects.length; q++) {
                    var rct = drawnLabelRects[q];
                    if (lx < rct.x + rct.w && lx + tw > rct.x && ly < rct.y + rct.h && ly + lh > rct.y) { collides = true; break; }
                }
            }
            if (collides) { continue; }
            drawnLabelRects.push({ x: lx, y: ly, w: tw, h: lh });
            ctx.fillStyle = (n === hoveredNode || n === selectedNode) ? inkColors.primary : inkColors.secondary;
            ctx.strokeStyle = colors.surface;
            ctx.lineWidth = 3 / view.k;
            ctx.strokeText(text, n.x, ly);
            ctx.fillText(text, n.x, ly);
            labelsDrawn++;
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    function drawNode(node, dimmed) {
        var color = nodeColor(node);
        var cfg = TYPE_CONFIG[node.t] || TYPE_CONFIG.app;
        var r = node.radius;
        ctx.globalAlpha = dimmed ? 0.14 : 1;

        /* selection / hover halo */
        if (node === selectedNode || node === hoveredNode) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
            ctx.fillStyle = colors.halo;
            ctx.fill();
        }
        /* critical/medium ring on identity nodes */
        if (node.r && node.t !== 'permApp' && node.t !== 'permDel') {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 3.2, 0, Math.PI * 2);
            ctx.strokeStyle = node.r === 'critical' ? colors.permCritical : colors.permMedium;
            ctx.lineWidth = 1.8;
            ctx.stroke();
        }

        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        switch (cfg.shape) {
            case 'circle':
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'dot':
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'ring':
                ctx.beginPath();
                ctx.arc(node.x, node.y, Math.max(2.5, r - 1), 0, Math.PI * 2);
                ctx.lineWidth = 2.4;
                ctx.stroke();
                break;
            case 'square':
                roundRectPath(node.x - r, node.y - r, r * 2, r * 2, Math.min(4, r * 0.45));
                ctx.fill();
                break;
            case 'squareOutline':
                roundRectPath(node.x - r, node.y - r, r * 2, r * 2, Math.min(4, r * 0.45));
                ctx.lineWidth = 2;
                ctx.stroke();
                break;
            case 'diamond':
                ctx.beginPath();
                ctx.moveTo(node.x, node.y - r * 1.15);
                ctx.lineTo(node.x + r * 1.15, node.y);
                ctx.lineTo(node.x, node.y + r * 1.15);
                ctx.lineTo(node.x - r * 1.15, node.y);
                ctx.closePath();
                ctx.fill();
                break;
            case 'hex':
                polygonPath(node.x, node.y, r * 1.12, 6, Math.PI / 6);
                ctx.fill();
                break;
            case 'star':
                starPath(node.x, node.y, r * 1.35, r * 0.6, 5);
                ctx.fill();
                break;
            default:
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
                ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function roundRectPath(x, y, w, h, rad) {
        ctx.beginPath();
        ctx.moveTo(x + rad, y);
        ctx.arcTo(x + w, y, x + w, y + h, rad);
        ctx.arcTo(x + w, y + h, x, y + h, rad);
        ctx.arcTo(x, y + h, x, y, rad);
        ctx.arcTo(x, y, x + w, y, rad);
        ctx.closePath();
    }

    function polygonPath(cx, cy, r, sides, rotation) {
        ctx.beginPath();
        for (var i = 0; i < sides; i++) {
            var a = rotation + i / sides * Math.PI * 2;
            var px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
            if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
        }
        ctx.closePath();
    }

    function starPath(cx, cy, outer, inner, points) {
        ctx.beginPath();
        for (var i = 0; i < points * 2; i++) {
            var r = (i % 2 === 0) ? outer : inner;
            var a = -Math.PI / 2 + i / (points * 2) * Math.PI * 2;
            var px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
            if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
        }
        ctx.closePath();
    }

    /* ------------------------------------------------------------------ */
    /* view helpers                                                        */
    /* ------------------------------------------------------------------ */
    function fitToView() {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
        nodes.forEach(function (n) {
            if (!n.visible) { return; }
            count++;
            if (n.x < minX) { minX = n.x; }
            if (n.x > maxX) { maxX = n.x; }
            if (n.y < minY) { minY = n.y; }
            if (n.y > maxY) { maxY = n.y; }
        });
        if (!count) { return; }
        var pad = 60;
        var w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
        var k = Math.min(2.2, Math.min(width / w, height / h));
        view.k = Math.max(0.05, k);
        view.x = width / 2 - (minX + maxX) / 2 * view.k;
        view.y = height / 2 - (minY + maxY) / 2 * view.k;
        scheduleFrame();
    }

    function flyTo(node) {
        userAdjustedView = true;
        var targetK = Math.max(view.k, 1.1);
        view.k = targetK;
        view.x = width / 2 - node.x * targetK;
        view.y = height / 2 - node.y * targetK;
        scheduleFrame();
    }

    function zoomBy(factor) {
        userAdjustedView = true;
        var cx = width / 2, cy = height / 2;
        var wx = (cx - view.x) / view.k, wy = (cy - view.y) / view.k;
        view.k = Math.min(6, Math.max(0.04, view.k * factor));
        view.x = cx - wx * view.k;
        view.y = cy - wy * view.k;
        scheduleFrame();
    }

    function screenToWorld(sx, sy) {
        return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
    }

    function findNodeAt(sx, sy) {
        var w = screenToWorld(sx, sy);
        var best = null, bestD = Infinity;
        var slack = Math.max(3, 6 / view.k);
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (!n.visible) { continue; }
            var dx = w.x - n.x, dy = w.y - n.y;
            var hit = n.radius + slack;
            var d2 = dx * dx + dy * dy;
            if (d2 < hit * hit && d2 < bestD) { best = n; bestD = d2; }
        }
        return best;
    }

    /* ------------------------------------------------------------------ */
    /* selection + details panel                                           */
    /* ------------------------------------------------------------------ */
    function select(node) {
        selectedNode = node;
        neighborSet = null;
        if (node) {
            neighborSet = {};
            neighborSet[node.id] = true;
            (adjacency[node.id] || []).forEach(function (adj) { neighborSet[adj.node.id] = true; });
            renderDetails(node);
            detailsEl.classList.add('open');
        }
        else {
            detailsEl.classList.remove('open');
        }
        scheduleFrame();
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function renderDetails(node) {
        var cfg = TYPE_CONFIG[node.t] || TYPE_CONFIG.app;
        var html = '';
        html += '<div class="mapDetailsHead">';
        html += '<span class="detailSwatch" style="background:' + escapeHtml(nodeColor(node)) + '"></span>';
        html += '<div><h3>' + escapeHtml(node.l) + '</h3>';
        html += '<div class="detailSub">' + escapeHtml(node.sub || cfg.label) + '</div>';
        if (node.r === 'critical') { html += '<div style="margin-top:6px"><span class="riskBadge critical">critical</span></div>'; }
        else if (node.r === 'medium') { html += '<div style="margin-top:6px"><span class="riskBadge medium">medium</span></div>'; }
        html += '</div>';
        html += '<button type="button" class="mapDetailsClose" aria-label="Close">×</button>';
        html += '</div>';
        html += '<div class="mapDetailsBody">';

        /* properties */
        var m = node.m || {};
        var rows = '';
        Object.keys(m).forEach(function (key) {
            var val = m[key];
            if (val === null || val === undefined || val === '') { return; }
            if (key === 'aadRoles') { return; }
            if (key === 'appPermissions' || key === 'delegatedPermissions') {
                var total = (val.critical || 0) + (val.medium || 0) + (val.unclassified || 0);
                if (!total) { return; }
                var partsTxt = [];
                if (val.critical) { partsTxt.push(val.critical + ' critical'); }
                if (val.medium) { partsTxt.push(val.medium + ' medium'); }
                if (val.unclassified) { partsTxt.push(val.unclassified + ' unclassified'); }
                rows += '<dt>' + (key === 'appPermissions' ? 'App permissions' : 'Delegated permissions') + '</dt><dd class="plain">' + escapeHtml(partsTxt.join(' · ')) + '</dd>';
                return;
            }
            if (typeof val === 'object') { return; }
            var label = META_LABELS[key] || key;
            var plain = typeof val !== 'string' || val.length < 20 || key === 'description' || key === 'displayName' || key === 'resource';
            rows += '<dt>' + escapeHtml(label) + '</dt><dd' + (plain && !/Id$/i.test(key) ? ' class="plain"' : '') + '>' + escapeHtml(String(val)) + '</dd>';
        });
        if (rows) { html += '<h4>Details</h4><dl class="detailProps">' + rows + '</dl>'; }

        if (m.aadRoles && m.aadRoles.length) {
            html += '<h4>Entra directory roles</h4><div class="neighborList">';
            m.aadRoles.forEach(function (role) {
                html += '<div style="padding:3px 8px;font-size:12.5px">' + (role.critical ? '<span class="riskBadge critical" style="margin-right:6px">critical</span>' : '') + escapeHtml(role.name) + '</div>';
            });
            html += '</div>';
        }

        /* connections grouped by kind */
        var groups = {};
        (adjacency[node.id] || []).forEach(function (adj) {
            var kind = adj.edge.k;
            if (!groups[kind]) { groups[kind] = []; }
            groups[kind].push(adj);
        });
        Object.keys(groups).forEach(function (kind) {
            var list = groups[kind];
            html += '<h4>' + escapeHtml(EDGE_KIND_LABEL[kind] || kind) + ' (' + list.length + ')</h4>';
            html += '<div class="neighborList">';
            var maxShow = 40;
            list.slice(0, maxShow).forEach(function (adj) {
                html += '<button type="button" data-node="' + escapeHtml(adj.node.id) + '">';
                html += '<span class="nDot" style="background:' + escapeHtml(nodeColor(adj.node)) + '"></span>';
                html += '<span>' + escapeHtml(adj.node.l) + '</span>';
                if (adj.edge.l) { html += '<span class="nKind">' + escapeHtml(adj.edge.l) + '</span>'; }
                html += '</button>';
            });
            if (list.length > maxShow) { html += '<div class="neighborMore">+ ' + (list.length - maxShow) + ' more…</div>'; }
            html += '</div>';
        });

        html += '</div>';
        detailsEl.innerHTML = html;

        detailsEl.querySelector('.mapDetailsClose').addEventListener('click', function () { select(null); });
        detailsEl.querySelectorAll('button[data-node]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var next = nodeById[btn.getAttribute('data-node')];
                if (next && next.visible) { select(next); flyTo(next); }
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /* tooltip                                                             */
    /* ------------------------------------------------------------------ */
    function showTooltip(node, sx, sy) {
        var html = '<div class="tipTitle">' + escapeHtml(node.l) + '</div>';
        html += '<div class="tipSub">' + escapeHtml(node.sub || (TYPE_CONFIG[node.t] || {}).label || node.t) + '</div>';
        if (node.r === 'critical') { html += '<div class="tipRisk critical">⚠ critical</div>'; }
        else if (node.r === 'medium') { html += '<div class="tipRisk medium">⚠ medium</div>'; }
        tooltipEl.innerHTML = html;
        tooltipEl.style.display = 'block';
        var rect = stageEl.getBoundingClientRect();
        var tx = sx + 14, ty = sy + 10;
        tooltipEl.style.left = '0px';
        tooltipEl.style.top = '0px';
        var tw = tooltipEl.offsetWidth, th = tooltipEl.offsetHeight;
        if (tx + tw > rect.width - 10) { tx = sx - tw - 12; }
        if (ty + th > rect.height - 10) { ty = sy - th - 10; }
        tooltipEl.style.left = tx + 'px';
        tooltipEl.style.top = ty + 'px';
    }

    function hideTooltip() { tooltipEl.style.display = 'none'; }

    /* ------------------------------------------------------------------ */
    /* toolbar: search, filters, buttons                                   */
    /* ------------------------------------------------------------------ */
    function initSearch() {
        var input = document.getElementById('mapSearch');
        var resultsEl = document.getElementById('mapSearchResults');
        if (!input || !resultsEl) { return; }

        function closeResults() { resultsEl.classList.remove('open'); resultsEl.innerHTML = ''; }

        input.addEventListener('input', function () {
            var q = input.value.trim().toLowerCase();
            if (q.length < 2) { closeResults(); return; }
            var matches = [];
            for (var i = 0; i < searchIndex.length && matches.length < 20; i++) {
                var entry = searchIndex[i];
                if (entry.node.visible && entry.hay.indexOf(q) !== -1) { matches.push(entry.node); }
            }
            if (!matches.length) { closeResults(); return; }
            resultsEl.innerHTML = matches.map(function (n) {
                var cfg = TYPE_CONFIG[n.t] || {};
                return '<button type="button" data-node="' + escapeHtml(n.id) + '">' +
                    '<span class="nDot" style="width:9px;height:9px;border-radius:3px;flex:none;background:' + escapeHtml(nodeColor(n)) + '"></span>' +
                    '<span>' + escapeHtml(n.l) + '</span>' +
                    '<span class="resultType">' + escapeHtml(cfg.label || n.t) + '</span>' +
                    '</button>';
            }).join('');
            resultsEl.classList.add('open');
            resultsEl.querySelectorAll('button[data-node]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var n = nodeById[btn.getAttribute('data-node')];
                    if (n) { select(n); flyTo(n); }
                    closeResults();
                    input.blur();
                });
            });
        });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') { closeResults(); input.blur(); }
            if (ev.key === 'Enter') {
                var first = resultsEl.querySelector('button[data-node]');
                if (first) { first.click(); }
            }
        });
        document.addEventListener('click', function (ev) {
            if (!resultsEl.contains(ev.target) && ev.target !== input) { closeResults(); }
        });
    }

    function initFilters() {
        var filtersEl = document.getElementById('mapFilters');
        if (!filtersEl) { return; }
        var html = '';
        FILTER_GROUPS.forEach(function (g) {
            /* skip groups with no nodes */
            var count = nodes.filter(function (n) { return g.types.indexOf(n.t) !== -1; }).length;
            if (!count) { return; }
            html += '<button type="button" class="mapChip" data-filter="' + g.key + '" data-shape="' + (g.shape === 'circle' ? 'circle' : 'square') + '" style="--chip-color:var(' + g.colorVar + ')">' +
                '<span class="chipDot"></span>' + escapeHtml(g.label) + ' <span style="opacity:.6">' + count + '</span></button>';
        });
        html += '<span style="width:1px;height:20px;background:var(--hairline);margin:0 2px"></span>';
        RISK_CHIPS.forEach(function (rc) {
            var count = nodes.filter(function (n) {
                if (n.t !== 'permApp' && n.t !== 'permDel' && n.t !== 'role') { return false; }
                var key = n.r === 'critical' ? 'critical' : (n.r === 'medium' ? 'medium' : 'none');
                return key === rc.key;
            }).length;
            if (!count) { return; }
            html += '<button type="button" class="mapChip" data-risk="' + rc.key + '" data-shape="circle" style="--chip-color:var(' + rc.colorVar + ')">' +
                '<span class="chipDot"></span>' + escapeHtml(rc.label) + ' <span style="opacity:.6">' + count + '</span></button>';
        });
        filtersEl.innerHTML = html;

        filtersEl.querySelectorAll('.mapChip').forEach(function (chip) {
            chip.addEventListener('click', function () {
                var fkey = chip.getAttribute('data-filter');
                var rkey = chip.getAttribute('data-risk');
                if (fkey) { typeFilter[fkey] = !typeFilter[fkey]; chip.classList.toggle('off', !typeFilter[fkey]); }
                if (rkey) { riskFilter[rkey] = !riskFilter[rkey]; chip.classList.toggle('off', !riskFilter[rkey]); }
                applyFilters();
            });
        });
    }

    function initButtons() {
        var btnFit = document.getElementById('mapBtnFit');
        var btnZoomIn = document.getElementById('mapBtnZoomIn');
        var btnZoomOut = document.getElementById('mapBtnZoomOut');
        var btnLayout = document.getElementById('mapBtnLayout');
        var btnFull = document.getElementById('mapBtnFullscreen');
        if (btnFit) { btnFit.addEventListener('click', function () { userAdjustedView = false; fitToView(); }); }
        if (btnZoomIn) { btnZoomIn.addEventListener('click', function () { zoomBy(1.35); }); }
        if (btnZoomOut) { btnZoomOut.addEventListener('click', function () { zoomBy(1 / 1.35); }); }
        if (btnLayout) { btnLayout.addEventListener('click', function () { didInitialFit = true; reheat(0.9); }); }
        if (btnFull) {
            btnFull.addEventListener('click', function () {
                sectionEl.classList.toggle('azadspiFullscreen');
                btnFull.textContent = sectionEl.classList.contains('azadspiFullscreen') ? '✕' : '⛶';
                resize();
                fitToView();
            });
        }
    }

    function initLegend() {
        var legendEl = document.getElementById('mapLegend');
        if (!legendEl) { return; }
        var shapes = { circle: 'circle', dot: 'dot', ring: 'ring', square: 'square', squareOutline: 'square', diamond: 'diamond', hex: 'hex', star: 'star' };
        var present = {};
        nodes.forEach(function (n) { present[n.t] = true; });
        var html = '';
        Object.keys(TYPE_CONFIG).forEach(function (t) {
            if (!present[t]) { return; }
            var cfg = TYPE_CONFIG[t];
            html += '<span class="legendItem"><span class="legendSwatch ' + shapes[cfg.shape] + '" style="--sw:var(' + cfg.colorVar + ')"></span>' + escapeHtml(cfg.label) + '</span>';
        });
        html += '<span class="legendItem"><span class="legendSwatch dot" style="--sw:var(--map-perm-critical)"></span>Critical permission</span>';
        html += '<span class="legendItem"><span class="legendSwatch dot" style="--sw:var(--map-perm-medium)"></span>Medium permission</span>';
        legendEl.innerHTML = html;
    }

    /* ------------------------------------------------------------------ */
    /* pointer interactions                                                */
    /* ------------------------------------------------------------------ */
    function initPointer() {
        canvas.addEventListener('pointerdown', function (ev) {
            canvas.setPointerCapture(ev.pointerId);
            var rect = canvas.getBoundingClientRect();
            var sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
            pointerDownPos = { x: sx, y: sy, vx: view.x, vy: view.y };
            moved = false;
            var hit = findNodeAt(sx, sy);
            if (hit) {
                draggingNode = hit;
                reheat(0.25);
            }
            else {
                panning = true;
                canvas.classList.add('dragging');
            }
            hideTooltip();
        });

        canvas.addEventListener('pointermove', function (ev) {
            var rect = canvas.getBoundingClientRect();
            var sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;

            if (draggingNode) {
                var w = screenToWorld(sx, sy);
                draggingNode.x = w.x;
                draggingNode.y = w.y;
                draggingNode.vx = 0; draggingNode.vy = 0;
                moved = true;
                reheat(0.2);
                return;
            }
            if (panning && pointerDownPos) {
                view.x = pointerDownPos.vx + (sx - pointerDownPos.x);
                view.y = pointerDownPos.vy + (sy - pointerDownPos.y);
                if (Math.abs(sx - pointerDownPos.x) + Math.abs(sy - pointerDownPos.y) > 4) { moved = true; userAdjustedView = true; }
                scheduleFrame();
                return;
            }
            /* hover */
            var hit = findNodeAt(sx, sy);
            if (hit !== hoveredNode) {
                hoveredNode = hit;
                canvas.classList.toggle('pointer', !!hit);
                scheduleFrame();
            }
            if (hit) { showTooltip(hit, sx, sy); } else { hideTooltip(); }
        });

        canvas.addEventListener('pointerup', function (ev) {
            var rect = canvas.getBoundingClientRect();
            var sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
            if (!moved) {
                var hit = findNodeAt(sx, sy);
                select(hit || null);
            }
            draggingNode = null;
            panning = false;
            pointerDownPos = null;
            canvas.classList.remove('dragging');
        });

        canvas.addEventListener('pointerleave', function () {
            hoveredNode = null;
            hideTooltip();
            canvas.classList.remove('pointer');
            scheduleFrame();
        });

        canvas.addEventListener('wheel', function (ev) {
            ev.preventDefault();
            userAdjustedView = true;
            var rect = canvas.getBoundingClientRect();
            var sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
            var factor = Math.pow(1.0015, -ev.deltaY);
            var wx = (sx - view.x) / view.k, wy = (sy - view.y) / view.k;
            view.k = Math.min(6, Math.max(0.04, view.k * factor));
            view.x = sx - wx * view.k;
            view.y = sy - wy * view.k;
            scheduleFrame();
        }, { passive: false });

        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                if (sectionEl.classList.contains('azadspiFullscreen')) {
                    sectionEl.classList.remove('azadspiFullscreen');
                    var btnFull = document.getElementById('mapBtnFullscreen');
                    if (btnFull) { btnFull.textContent = '⛶'; }
                    resize();
                }
                select(null);
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* sizing                                                              */
    /* ------------------------------------------------------------------ */
    function resize() {
        var rect = stageEl.getBoundingClientRect();
        width = Math.max(200, rect.width);
        height = Math.max(200, rect.height);
        dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        scheduleFrame();
    }

    /* ------------------------------------------------------------------ */
    /* bootstrap                                                           */
    /* ------------------------------------------------------------------ */
    function init() {
        sectionEl = document.getElementById('identityMap');
        var dataEl = document.getElementById('azadspiMapData');
        if (!sectionEl) { return; }
        stageEl = sectionEl.querySelector('.mapStage');
        canvas = document.getElementById('mapCanvas');
        tooltipEl = sectionEl.querySelector('.mapTooltip');
        detailsEl = document.getElementById('mapDetails');
        if (!stageEl || !canvas) { return; }

        var data = null;
        try { data = JSON.parse(dataEl.textContent); } catch (e) { data = null; }
        if (!data || !data.nodes || !data.nodes.length) {
            var notice = document.createElement('div');
            notice.className = 'mapNotice';
            notice.textContent = 'No map data available.';
            stageEl.appendChild(notice);
            return;
        }

        ctx = canvas.getContext('2d');
        resolveColors();
        prepare(data);
        applyFiltersInitialState();
        initSearch();
        initFilters();
        initButtons();
        initLegend();
        initPointer();
        resize();
        window.addEventListener('resize', resize);
        document.addEventListener('azadspi:themechange', function () {
            resolveColors();
            scheduleFrame();
        });

        alphaTarget = 0;
        alpha = 1;
        simRunning = true;
        scheduleFrame();
    }

    function applyFiltersInitialState() {
        nodes.forEach(function (n) { n.visible = true; });
        edges.forEach(function (e) { e.visible = true; });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AzADSPIMap = { reinit: init };
})();
