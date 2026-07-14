/* AzADServicePrincipalInsights - interactive Permission Map
   Self-contained force-directed graph on <canvas>. No external libraries.
   Data contract: JSON in the element with id "azadspiMapData": { nodes, edges, stats }
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
        agent: { label: 'Agent identity', colorVar: '--map-agent', shape: 'triangle', baseRadius: 8 },
        agentBp: { label: 'Agent blueprint', colorVar: '--map-agent', shape: 'triangleOutline', baseRadius: 9 },
        user: { label: 'User', colorVar: '--map-user', shape: 'circle', baseRadius: 6 },
        guest: { label: 'Guest user', colorVar: '--map-guest', shape: 'circleOutline', baseRadius: 6 },
        group: { label: 'Group', colorVar: '--map-group', shape: 'hex', baseRadius: 7 },
        resource: { label: 'Resource API', colorVar: '--map-resource', shape: 'squareOutline', baseRadius: 10 },
        permApp: { label: 'Application permission', colorVar: '--map-perm-none', shape: 'dot', baseRadius: 4.5 },
        permDel: { label: 'Delegated permission', colorVar: '--map-perm-none', shape: 'ring', baseRadius: 4.5 },
        role: { label: 'Entra directory role', colorVar: '--map-role', shape: 'star', baseRadius: 7 }
    };

    var FILTER_GROUPS = [
        { key: 'apps', label: 'Apps', types: ['app', 'appExt'], colorVar: '--map-app', shape: 'square' },
        { key: 'mi', label: 'Managed identities', types: ['mi'], colorVar: '--map-mi', shape: 'square' },
        { key: 'agents', label: 'Agents', types: ['agent', 'agentBp'], colorVar: '--map-agent', shape: 'square' },
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
        aadRole: 'directory role',
        sponsors: 'sponsor of',
        instanceOf: 'instance of blueprint'
    };

    var LINK_DISTANCE = {
        owns: 62, permApp: 48, permDel: 48, onApi: 55, usesApi: 95,
        assignedTo: 72, memberOf: 70, aadRole: 60, sponsors: 62, instanceOf: 55
    };

    var META_LABELS = {
        objectId: 'Object ID', appId: 'App (client) ID', objectType: 'Type', spType: 'SP type',
        accountEnabled: 'Enabled', createdDateTime: 'Created', orgId: 'Owner org', signInAudience: 'Sign-in audience',
        secretCount: 'Secrets', certCount: 'Certificates', federatedCredentialCount: 'Federated credentials',
        azureRoleCount: 'Azure role assignments', assignedToCount: 'Assigned principals',
        spOwnerCount: 'SP owners', appOwnerCount: 'App owners', principalType: 'Principal type',
        miResourceType: 'MI resource type', miResourceScope: 'MI resource scope',
        resource: 'Resource API', displayName: 'Display name', description: 'Description',
        classification: 'Classification', roleType: 'Role type', roleDefinitionId: 'Role definition ID',
        blueprintId: 'Blueprint (app) ID', lastSignIn: 'Last sign-in',
        aggregateCount: 'Members', connectedCount: 'Connected', unconnectedCount: 'Unconnected',
        publisher: 'Publisher / owner organization'
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
    var pathMode = false, pathSource = null, pathResult = null;
    var hideUnconnected = false;
    var staleOnly = false;
    var hintEl = null, hintTimer = null;
    var edgeKindFilter = {};
    var layoutMode = 'overview';
    var investigationRoot = null, investigationDepth = 1, investigationPreviousLayout = 'overview';
    var lowValueExternal = {}, externalAggregates = [], externalExpandedGroups = {}, externalExpanded = false;
    var initialized = false;
    var multiSelection = [];
    var miniCanvas = null, miniCtx = null, miniTransform = null, miniWidth = 150, miniHeight = 96;

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
        colors.page = v('--bg-page', '#ffffff');
        colors.accent = v('--accent', '#2a78d6');
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
        edgeKindFilter = {};
        lowValueExternal = {};
        externalAggregates = [];
        externalExpandedGroups = {};
        externalExpanded = false;

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

        /* Collapse only disconnected, unflagged external SPs. Connected identities
           stay first-class so their real API relationships remain visible and usable. */
        var externalCandidates = nodes.filter(function (n) {
            var m = n.m || {}, change = m.changeType || m.change;
            var appPerms = m.appPermissions || {}, delPerms = m.delegatedPermissions || {};
            var hasGovernanceSignal = m.spOwnerCount || m.appOwnerCount || m.assignedToCount ||
                m.azureRoleCount || (m.aadRoles && m.aadRoles.length) ||
                appPerms.critical || appPerms.medium || delPerms.critical || delPerms.medium;
            return n.t === 'appExt' && n.degree === 0 && !n.r && !m.stale && !change && !hasGovernanceSignal;
        });
        if (externalCandidates.length > 1) {
            var publisherGroups = {}, singletonCandidates = [];
            externalCandidates.forEach(function (n) {
                var m = n.m || {};
                var publisher = m.publisher || m.verifiedPublisher || m.publisherName || m.orgName || m.orgId || 'Other publishers';
                publisher = String(publisher);
                if (!publisherGroups[publisher]) { publisherGroups[publisher] = []; }
                publisherGroups[publisher].push(n);
            });
            Object.keys(publisherGroups).forEach(function (publisher) {
                if (publisherGroups[publisher].length === 1) {
                    singletonCandidates.push(publisherGroups[publisher][0]);
                    delete publisherGroups[publisher];
                }
            });
            if (singletonCandidates.length > 1) { publisherGroups['Other publishers'] = singletonCandidates; }
            Object.keys(publisherGroups).forEach(function (publisher, index) {
                var members = publisherGroups[publisher];
                var connectedCount = members.filter(function (n) { return n.degree > 0; }).length;
                var aggregate = {
                    id: '__azadspi_external_low_value_' + index + '__', t: 'appExt',
                    l: publisher,
                    sub: members.length + ' low-risk external service principals', r: null,
                    m: {
                        aggregate: true, publisher: publisher, aggregateCount: members.length,
                        connectedCount: connectedCount, unconnectedCount: members.length - connectedCount
                    },
                    degree: 0, visible: true, _aggregate: true
                };
                members.forEach(function (n) { lowValueExternal[n.id] = aggregate.id; });
                externalAggregates.push(aggregate);
                nodes.push(aggregate);
                nodeById[aggregate.id] = aggregate;
                adjacency[aggregate.id] = [];
            });
        }

        edges.forEach(function (e) { edgeKindFilter[e.k] = true; });

        /* cluster-seeded initial positions: each type starts in its own zone */
        var clusterAngle = {
            app: -2.2, appExt: -1.2, mi: -2.9, agent: -1.7, agentBp: -1.9, resource: 0, permApp: -0.5, permDel: 0.5,
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
            if (n._aggregate) { n.radius = Math.min(26, 13 + Math.sqrt(n.m.aggregateCount) * 0.45); }
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
        arrangeOverview();
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
            if (vis && staleOnly) { vis = !!(n.m && n.m.stale); }
            if (vis && n._aggregate) { vis = !externalExpanded && !externalExpandedGroups[n.id] && !staleOnly; }
            else if (vis && lowValueExternal[n.id]) { vis = externalExpanded || !!externalExpandedGroups[lowValueExternal[n.id]]; }
            n._baseVisible = vis;
            n.visible = vis;
        });

        if (investigationRoot) {
            var egoSet = neighborhoodAtDepth(investigationRoot, investigationDepth, true);
            nodes.forEach(function (n) { n.visible = n.visible && !!egoSet[n.id]; });
        }

        edges.forEach(function (e) {
            e.visible = e.sn.visible && e.dn.visible && edgeKindFilter[e.k] !== false;
        });
        if (hideUnconnected) {
            var visibleEdgeCount = {};
            edges.forEach(function (e) {
                if (!e.visible) { return; }
                visibleEdgeCount[e.s] = (visibleEdgeCount[e.s] || 0) + 1;
                visibleEdgeCount[e.d] = (visibleEdgeCount[e.d] || 0) + 1;
            });
            nodes.forEach(function (n) {
                if (n.visible && !n._aggregate && !visibleEdgeCount[n.id]) { n.visible = false; }
            });
        }
        if (selectedNode && !selectedNode.visible) { select(null); }
        if (multiSelection.length) {
            multiSelection = multiSelection.filter(function (n) { return n.visible; });
            if (multiSelection.length) {
                updateMultiNeighborhood();
                renderMultiDetails();
            }
            else if (!selectedNode) { detailsEl.classList.remove('open'); }
        }
        if (pathResult) {
            var pathBroken = false;
            Object.keys(pathResult.nodeSet).forEach(function (id) {
                if (nodeById[id] && !nodeById[id].visible) { pathBroken = true; }
            });
            if (pathBroken) { clearPath(); }
        }
        if (hoveredNode && !hoveredNode.visible) { hoveredNode = null; hideTooltip(); }
        if (selectedNode && selectedNode.visible) {
            updateSelectionNeighborhood();
            renderDetails(selectedNode);
        }
        arrangeCurrentLayout();
        reheat(0.35);
    }

    function neighborhoodAtDepth(root, depth, useBaseVisibility) {
        var found = {}, queue = [], qi = 0;
        if (!root) { return found; }
        found[root.id] = 0;
        queue.push(root);
        while (qi < queue.length) {
            var current = queue[qi++];
            var currentDepth = found[current.id];
            if (currentDepth >= depth) { continue; }
            (adjacency[current.id] || []).forEach(function (adj) {
                if (edgeKindFilter[adj.edge.k] === false || found[adj.node.id] !== undefined) { return; }
                if (useBaseVisibility && !adj.node._baseVisible) { return; }
                found[adj.node.id] = currentDepth + 1;
                queue.push(adj.node);
            });
        }
        return found;
    }

    function updateSelectionNeighborhood() {
        neighborSet = {};
        if (!selectedNode) { return; }
        neighborSet[selectedNode.id] = true;
        (adjacency[selectedNode.id] || []).forEach(function (adj) {
            if (adj.edge.visible && adj.node.visible) { neighborSet[adj.node.id] = true; }
        });
    }

    /* ------------------------------------------------------------------ */
    /* layout lenses                                                       */
    /* ------------------------------------------------------------------ */
    function setLensTarget(node, x, y, snap) {
        node._lensX = x;
        node._lensY = y;
        if (snap) {
            node.x = x; node.y = y;
            node.vx = 0; node.vy = 0;
        }
    }

    function arrangeOverview() {
        var clusterAngle = {
            app: -2.2, appExt: -1.2, mi: -2.9, agent: -1.7, agentBp: -1.9,
            resource: 0, permApp: -0.5, permDel: 0.5, user: 2.4,
            guest: 2.0, group: 1.5, role: 3.0
        };
        var byType = {};
        nodes.forEach(function (n) {
            if (!byType[n.t]) { byType[n.t] = []; }
            byType[n.t].push(n);
        });
        Object.keys(byType).forEach(function (type) {
            var list = byType[type];
            var angle = clusterAngle[type] === undefined ? 0 : clusterAngle[type];
            var cx = Math.cos(angle) * 330, cy = Math.sin(angle) * 250;
            list.forEach(function (n, idx) {
                var spiral = idx * 2.3999632297;
                var radius = 20 + Math.sqrt(idx) * 24;
                setLensTarget(n, cx + Math.cos(spiral) * radius, cy + Math.sin(spiral) * radius, false);
            });
        });
    }

    function exposureLayer(node) {
        if (node.t === 'user' || node.t === 'guest' || node.t === 'group') { return 0; }
        if (node.t === 'app' || node.t === 'appExt' || node.t === 'mi' || node.t === 'agent' || node.t === 'agentBp') { return 1; }
        if (node.t === 'permApp' || node.t === 'permDel') { return 2; }
        return 3;
    }

    function arrangeExposure() {
        var layers = [[], [], [], []];
        nodes.forEach(function (n) { if (n.visible) { layers[exposureLayer(n)].push(n); } });
        layers.forEach(function (list, layer) {
            list.sort(function (a, b) {
                if (b.degree !== a.degree) { return b.degree - a.degree; }
                return String(a.l || '').localeCompare(String(b.l || ''));
            });
            var spacing = Math.max(18, Math.min(52, 1400 / Math.max(1, list.length)));
            list.forEach(function (n, idx) {
                setLensTarget(n, (layer - 1.5) * 285, (idx - (list.length - 1) / 2) * spacing, false);
            });
        });
        if (pathResult && pathResult.list) {
            pathResult.list.forEach(function (n, idx) {
                setLensTarget(n, (idx - (pathResult.list.length - 1) / 2) * 190, 0, false);
            });
        }
    }

    function arrangeInvestigation() {
        if (!investigationRoot) { return; }
        var rings = [], distance = neighborhoodAtDepth(investigationRoot, investigationDepth, false);
        Object.keys(distance).forEach(function (id) {
            var n = nodeById[id], depth = distance[id];
            if (!n || !n.visible) { return; }
            if (!rings[depth]) { rings[depth] = []; }
            rings[depth].push(n);
        });
        setLensTarget(investigationRoot, 0, 0, true);
        for (var depth = 1; depth < rings.length; depth++) {
            var ring = rings[depth] || [];
            ring.sort(function (a, b) { return b.degree - a.degree; });
            ring.forEach(function (n, idx) {
                var angle = -Math.PI / 2 + idx / Math.max(1, ring.length) * Math.PI * 2;
                setLensTarget(n, Math.cos(angle) * depth * 190, Math.sin(angle) * depth * 190, true);
            });
        }
    }

    function arrangeCurrentLayout() {
        if (layoutMode === 'investigation') { arrangeInvestigation(); }
        else if (layoutMode === 'exposure') { arrangeExposure(); }
        else { arrangeOverview(); }
    }

    function updateLensButtons() {
        ['overview', 'investigation', 'exposure'].forEach(function (mode) {
            var btn = document.getElementById('mapBtn' + mode.charAt(0).toUpperCase() + mode.slice(1));
            if (btn) {
                btn.classList.toggle('active', layoutMode === mode);
                btn.setAttribute('aria-pressed', layoutMode === mode ? 'true' : 'false');
            }
        });
    }

    function activateInvestigation(node, depth) {
        if (!node || node._aggregate) {
            showHint('Select an identity first, then open Investigation', 2800);
            return;
        }
        if (!investigationRoot) { investigationPreviousLayout = layoutMode === 'investigation' ? 'overview' : layoutMode; }
        investigationRoot = node;
        investigationDepth = Math.max(1, depth || 1);
        layoutMode = 'investigation';
        multiSelection = [];
        selectedNode = node;
        applyFilters();
        updateSelectionNeighborhood();
        renderDetails(node);
        detailsEl.classList.add('open');
        updateLensButtons();
        userAdjustedView = true;
        fitToView();
        emitMapEvent('azadspi:map-select', mapEventDetail(node));
    }

    function expandInvestigation() {
        if (!investigationRoot) {
            activateInvestigation(selectedNode, 1);
            return;
        }
        investigationDepth++;
        applyFilters();
        renderDetails(selectedNode || investigationRoot);
        fitToView();
        showHint('Investigation expanded to ' + investigationDepth + ' hops', 2200);
    }

    function restoreInvestigation(nextLayout) {
        if (!investigationRoot) {
            if (nextLayout) { setLayoutMode(nextLayout); }
            return;
        }
        investigationRoot = null;
        investigationDepth = 1;
        layoutMode = nextLayout || investigationPreviousLayout || 'overview';
        applyFilters();
        updateLensButtons();
        fitToView();
    }

    function setLayoutMode(mode) {
        if (mode === 'investigation') {
            activateInvestigation(selectedNode, 1);
            return;
        }
        if (investigationRoot) {
            restoreInvestigation(mode);
            return;
        }
        layoutMode = mode;
        arrangeCurrentLayout();
        updateLensButtons();
        didInitialFit = true;
        userAdjustedView = false;
        reheat(0.75);
        fitToView();
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
            if (n._lensX !== undefined && n._lensY !== undefined) {
                var lensStrength = layoutMode === 'investigation' ? 0.09 : 0.045;
                n.vx += (n._lensX - n.x) * lensStrength * alpha;
                n.vy += (n._lensY - n.y) * lensStrength * alpha;
            }
            n.vx -= n.x * 0.024 * alpha;
            n.vy -= n.y * 0.024 * alpha;
            if (n === draggingNode) { n.vx = 0; n.vy = 0; continue; }
            if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
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

    function nodeIsSelected(node) {
        if (node === selectedNode) { return true; }
        for (var i = 0; i < multiSelection.length; i++) {
            if (multiSelection[i] === node) { return true; }
        }
        return false;
    }

    function collectRenderEdges() {
        var grouped = {}, result = [];
        edges.forEach(function (edge) {
            if (!edge.visible) { return; }
            var key = edge.s + '\u0001' + edge.d + '\u0001' + edge.k;
            var group = grouped[key];
            if (!group) {
                group = grouped[key] = { edge: edge, count: 0, onPath: false };
                result.push(group);
            }
            group.count++;
            group.onPath = group.onPath || !!edge.onPath;
            if (edge.r === 'critical' || (edge.r === 'medium' && group.edge.r !== 'critical')) { group.edge = edge; }
        });
        return result;
    }

    function drawArrowhead(edge, color) {
        var dx = edge.dn.x - edge.sn.x, dy = edge.dn.y - edge.sn.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dx / dist, uy = dy / dist;
        var size = 5.5 / view.k;
        var endX = edge.dn.x - ux * (edge.dn.radius + size * 0.35);
        var endY = edge.dn.y - uy * (edge.dn.radius + size * 0.35);
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - ux * size - uy * size * 0.65, endY - uy * size + ux * size * 0.65);
        ctx.lineTo(endX - ux * size + uy * size * 0.65, endY - uy * size - ux * size * 0.65);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
    }

    function drawEdgeCount(edge, count) {
        if (count < 2 || view.k < 0.18) { return; }
        var x = (edge.sn.x + edge.dn.x) / 2, y = (edge.sn.y + edge.dn.y) / 2;
        var r = 7 / view.k;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = colors.surface;
        ctx.fill();
        ctx.strokeStyle = colors.edge;
        ctx.lineWidth = Math.max(0.5, 1 / view.k);
        ctx.stroke();
        ctx.fillStyle = inkColors.secondary;
        ctx.font = '600 ' + (9 / view.k) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(count), x, y);
    }

    function draw() {
        if (!ctx) { return; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.translate(view.x, view.y);
        ctx.scale(view.k, view.k);

        var hasSelection = !!selectedNode || multiSelection.length > 0;
        var i, e, n;

        /* Edges are grouped for rendering only; raw edges remain intact for
           simulation, details, path finding, and export. */
        var renderEdges = collectRenderEdges();
        ctx.lineWidth = Math.max(0.4, 1 / view.k);
        for (i = 0; i < renderEdges.length; i++) {
            var rendered = renderEdges[i];
            e = rendered.edge;
            var strokeColor;
            ctx.lineWidth = Math.max(0.4, 1 / view.k);
            if (pathResult) {
                if (rendered.onPath) {
                    strokeColor = colors.accent;
                    ctx.lineWidth = Math.max(1.2, 2.4 / view.k);
                }
                else {
                    strokeColor = colors.edgeDim;
                    ctx.lineWidth = Math.max(0.4, 1 / view.k);
                }
                ctx.strokeStyle = strokeColor;
                ctx.beginPath();
                ctx.moveTo(e.sn.x, e.sn.y);
                ctx.lineTo(e.dn.x, e.dn.y);
                ctx.stroke();
                drawArrowhead(e, strokeColor);
                if (rendered.onPath) { drawEdgeCount(e, rendered.count); }
                continue;
            }
            var inFocus = !hasSelection || (neighborSet && neighborSet[e.sn.id] && neighborSet[e.dn.id] && (nodeIsSelected(e.sn) || nodeIsSelected(e.dn)));
            if (hasSelection && !inFocus) {
                strokeColor = colors.edgeDim;
            }
            else if (e.r === 'critical') {
                strokeColor = colors.permCritical;
                ctx.lineWidth = Math.max(0.8, 1.6 / view.k);
            }
            else if (e.r === 'medium') {
                strokeColor = colors.permMedium;
                ctx.lineWidth = Math.max(0.7, 1.3 / view.k);
            }
            else {
                strokeColor = colors.edge;
                ctx.lineWidth = Math.max(0.4, 1 / view.k);
            }
            if (hasSelection && inFocus && !nodeIsSelected(e.sn) && !nodeIsSelected(e.dn)) {
                strokeColor = colors.edgeDim;
            }
            ctx.strokeStyle = strokeColor;
            ctx.beginPath();
            ctx.moveTo(e.sn.x, e.sn.y);
            ctx.lineTo(e.dn.x, e.dn.y);
            ctx.stroke();
            drawArrowhead(e, strokeColor);
            if (!hasSelection || inFocus) { drawEdgeCount(e, rendered.count); }
        }

        /* nodes */
        for (i = 0; i < nodes.length; i++) {
            n = nodes[i];
            if (!n.visible) { continue; }
            var dimmed;
            if (pathResult) { dimmed = !pathResult.nodeSet[n.id]; }
            else { dimmed = hasSelection && !(neighborSet && neighborSet[n.id]); }
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
            var isFocus = n === hoveredNode || nodeIsSelected(n) || (hasSelection && neighborSet && neighborSet[n.id]) || (pathResult && pathResult.nodeSet[n.id]);
            if (!isFocus && n.radius * view.k < 8.5 && n.degree < minDegreeForLabel) { continue; }
            if ((hasSelection || pathResult) && !isFocus) { continue; }
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
            ctx.fillStyle = (n === hoveredNode || nodeIsSelected(n)) ? inkColors.primary : inkColors.secondary;
            ctx.strokeStyle = colors.surface;
            ctx.lineWidth = 3 / view.k;
            ctx.strokeText(text, n.x, ly);
            ctx.fillText(text, n.x, ly);
            labelsDrawn++;
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        drawMiniMap();
    }

    function drawNode(node, dimmed) {
        var color = nodeColor(node);
        var cfg = TYPE_CONFIG[node.t] || TYPE_CONFIG.app;
        var r = node.radius;
        ctx.globalAlpha = dimmed ? 0.14 : 1;

        /* Snapshot change overlay: added/new, removed, and modified nodes. */
        var changeType = nodeChangeType(node);
        if (changeType) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 6.2, 0, Math.PI * 2);
            ctx.strokeStyle = changeColor(changeType);
            ctx.lineWidth = 2.2;
            if (ctx.setLineDash) { ctx.setLineDash([4, 2]); }
            ctx.stroke();
            if (ctx.setLineDash) { ctx.setLineDash([]); }
        }

        /* selection / hover halo */
        if (nodeIsSelected(node) || node === hoveredNode) {
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
            case 'circleOutline':
                ctx.beginPath();
                ctx.arc(node.x, node.y, Math.max(2.5, r - 1), 0, Math.PI * 2);
                ctx.lineWidth = 2.2;
                ctx.stroke();
                break;
            case 'triangle':
                polygonPath(node.x, node.y, r * 1.25, 3, -Math.PI / 2);
                ctx.fill();
                break;
            case 'triangleOutline':
                polygonPath(node.x, node.y, r * 1.25, 3, -Math.PI / 2);
                ctx.lineWidth = 2.2;
                ctx.stroke();
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
        if (node._aggregate) {
            ctx.fillStyle = colors.surface;
            ctx.font = '700 ' + Math.max(8, r * 0.72) + 'px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(node.m.aggregateCount), node.x, node.y);
        }
        if (changeType) {
            var mark = changeType === 'added' ? '+' : (changeType === 'removed' ? '−' : '•');
            ctx.beginPath();
            ctx.arc(node.x + r * 0.82, node.y - r * 0.82, 5.5, 0, Math.PI * 2);
            ctx.fillStyle = changeColor(changeType);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 8px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(mark, node.x + r * 0.82, node.y - r * 0.82 - 0.4);
        }
        ctx.globalAlpha = 1;
    }

    function nodeChangeType(node) {
        var value = node && node.m && (node.m.changeType || node.m.change);
        if (value && typeof value === 'object') { value = value.type || value.state || value.kind; }
        if (value === true) { return 'changed'; }
        value = String(value || '').toLowerCase();
        if (value === 'new' || value === 'add' || value === 'added') { return 'added'; }
        if (value === 'delete' || value === 'deleted' || value === 'remove' || value === 'removed') { return 'removed'; }
        if (value) { return 'changed'; }
        return '';
    }

    function changeColor(changeType) {
        if (changeType === 'added') { return '#2e8540'; }
        if (changeType === 'removed') { return '#c23934'; }
        return '#d98200';
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
    function fitToView(nodeList) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
        (nodeList || nodes).forEach(function (n) {
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

    function initMiniMap() {
        miniCanvas = document.getElementById('mapMiniCanvas');
        if (!miniCanvas) {
            miniCanvas = document.createElement('canvas');
            miniCanvas.id = 'mapMiniCanvas';
            miniCanvas.className = 'mapMiniMap';
            miniCanvas.width = miniWidth;
            miniCanvas.height = miniHeight;
            miniCanvas.setAttribute('aria-label', 'Permission map overview and viewport navigator');
            miniCanvas.setAttribute('role', 'img');
            stageEl.appendChild(miniCanvas);
        }
        miniCtx = miniCanvas.getContext('2d');

        function navigate(event) {
            if (!miniTransform) { return; }
            var rect = miniCanvas.getBoundingClientRect();
            var sx = event.clientX - rect.left, sy = event.clientY - rect.top;
            var wx = (sx - miniTransform.offsetX) / miniTransform.scale + miniTransform.minX;
            var wy = (sy - miniTransform.offsetY) / miniTransform.scale + miniTransform.minY;
            userAdjustedView = true;
            view.x = width / 2 - wx * view.k;
            view.y = height / 2 - wy * view.k;
            scheduleFrame();
        }
        miniCanvas.addEventListener('pointerdown', function (event) {
            miniCanvas.setPointerCapture(event.pointerId);
            navigate(event);
        });
        miniCanvas.addEventListener('pointermove', function (event) {
            if (miniCanvas.hasPointerCapture && miniCanvas.hasPointerCapture(event.pointerId)) { navigate(event); }
        });
    }

    function resizeMiniMap() {
        if (!miniCanvas) { return; }
        var rect = miniCanvas.getBoundingClientRect();
        miniWidth = Math.max(80, rect.width || 150);
        miniHeight = Math.max(52, rect.height || 96);
        miniCanvas.width = Math.round(miniWidth * dpr);
        miniCanvas.height = Math.round(miniHeight * dpr);
    }

    function drawMiniMap() {
        if (!miniCtx || !miniCanvas) { return; }
        var mw = miniWidth, mh = miniHeight, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        var visible = nodes.filter(function (n) { return n.visible; });
        if (!visible.length) { return; }
        visible.forEach(function (n) {
            minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
            minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
        });
        var worldLeft = -view.x / view.k, worldRight = (width - view.x) / view.k;
        var worldTop = -view.y / view.k, worldBottom = (height - view.y) / view.k;
        minX = Math.min(minX, worldLeft); maxX = Math.max(maxX, worldRight);
        minY = Math.min(minY, worldTop); maxY = Math.max(maxY, worldBottom);
        var pad = 9, rangeX = Math.max(1, maxX - minX), rangeY = Math.max(1, maxY - minY);
        var scale = Math.min((mw - pad * 2) / rangeX, (mh - pad * 2) / rangeY);
        var offsetX = pad + ((mw - pad * 2) - rangeX * scale) / 2;
        var offsetY = pad + ((mh - pad * 2) - rangeY * scale) / 2;
        miniTransform = { minX: minX, minY: minY, scale: scale, offsetX: offsetX, offsetY: offsetY };

        miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        miniCtx.clearRect(0, 0, mw, mh);
        miniCtx.fillStyle = colors.surface;
        miniCtx.fillRect(0, 0, mw, mh);
        visible.forEach(function (n) {
            var x = offsetX + (n.x - minX) * scale, y = offsetY + (n.y - minY) * scale;
            miniCtx.beginPath();
            miniCtx.arc(x, y, nodeIsSelected(n) ? 2.7 : 1.35, 0, Math.PI * 2);
            miniCtx.fillStyle = nodeIsSelected(n) ? colors.accent : nodeColor(n);
            miniCtx.fill();
        });
        var vx = offsetX + (worldLeft - minX) * scale, vy = offsetY + (worldTop - minY) * scale;
        miniCtx.strokeStyle = colors.accent;
        miniCtx.lineWidth = 1.25;
        miniCtx.strokeRect(vx, vy, Math.max(2, (worldRight - worldLeft) * scale), Math.max(2, (worldBottom - worldTop) * scale));
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
    function emitMapEvent(name, detail) {
        var event;
        try { event = new CustomEvent(name, { detail: detail, bubbles: true }); }
        catch (e) {
            event = document.createEvent('CustomEvent');
            event.initCustomEvent(name, true, false, detail);
        }
        (sectionEl || document).dispatchEvent(event);
    }

    function mapEventDetail(node) {
        var m = node && node.m || {};
        return {
            source: 'permission-map', id: node ? node.id : null,
            objectId: m.objectId || null, appId: m.appId || null,
            type: node ? node.t : null, label: node ? node.l : null,
            metadata: node ? m : null
        };
    }

    function multiMapEventDetail() {
        return {
            source: 'permission-map', ids: multiSelection.map(function (n) { return n.id; }),
            objectIds: multiSelection.map(function (n) { return n.m && n.m.objectId; }).filter(Boolean),
            appIds: multiSelection.map(function (n) { return n.m && n.m.appId; }).filter(Boolean),
            nodes: multiSelection.map(function (n) { return mapEventDetail(n); })
        };
    }

    function updateMultiNeighborhood() {
        neighborSet = {};
        multiSelection.forEach(function (n) {
            neighborSet[n.id] = true;
            (adjacency[n.id] || []).forEach(function (adj) {
                if (adj.edge.visible && adj.node.visible) { neighborSet[adj.node.id] = true; }
            });
        });
    }

    function toggleMultiSelection(node) {
        if (!node || node._aggregate) { select(node || null); return; }
        if (selectedNode) {
            multiSelection = [selectedNode];
            selectedNode = null;
        }
        var index = multiSelection.indexOf(node);
        if (index === -1) { multiSelection.push(node); }
        else { multiSelection.splice(index, 1); }
        pathResult = null;
        if (!multiSelection.length) { select(null); return; }
        updateMultiNeighborhood();
        renderMultiDetails();
        detailsEl.classList.add('open');
        updateDeepLink(null);
        emitMapEvent('azadspi:map-select', multiMapEventDetail());
        scheduleFrame();
    }

    function select(node) {
        multiSelection = [];
        selectedNode = node;
        neighborSet = null;
        pathResult = null;
        if (node) {
            updateSelectionNeighborhood();
            renderDetails(node);
            detailsEl.classList.add('open');
        }
        else {
            detailsEl.classList.remove('open');
        }
        updateDeepLink(node ? node.id : null);
        emitMapEvent('azadspi:map-select', mapEventDetail(node));
        scheduleFrame();
    }

    function findNodeByReference(detail) {
        if (!detail) { return null; }
        var direct = detail.id || detail.nodeId;
        if (direct && nodeById[direct]) { return nodeById[direct]; }
        var objectId = String(detail.objectId || '').toLowerCase();
        var appId = String(detail.appId || '').toLowerCase();
        for (var i = 0; i < nodes.length; i++) {
            var m = nodes[i].m || {};
            if (objectId && String(m.objectId || '').toLowerCase() === objectId) { return nodes[i]; }
            if (appId && String(m.appId || '').toLowerCase() === appId) { return nodes[i]; }
        }
        return null;
    }

    function focusNode(node) {
        if (!node) { return false; }
        if (lowValueExternal[node.id]) { externalExpandedGroups[lowValueExternal[node.id]] = true; }
        var groupKey = nodeFilterGroup(node);
        if (groupKey) { typeFilter[groupKey] = true; }
        if (node.r === 'critical' || node.r === 'medium') { riskFilter[node.r] = true; }
        staleOnly = false;
        hideUnconnected = false;
        if (investigationRoot) {
            investigationRoot = null;
            investigationDepth = 1;
            layoutMode = investigationPreviousLayout || 'overview';
        }
        applyFilters();
        syncFilterChips();
        if (!node.visible) { return false; }
        select(node);
        flyTo(node);
        return true;
    }

    /* deep link: #map=<nodeId> selects the node on load and updates as you explore */
    function updateDeepLink(nodeId) {
        try {
            if (nodeId) { history.replaceState(null, '', '#map=' + encodeURIComponent(nodeId)); }
            else if (location.hash.indexOf('#map=') === 0) { history.replaceState(null, '', location.pathname + location.search); }
        } catch (e) { /* history API unavailable (some file:// contexts) */ }
    }

    function applyDeepLink() {
        var match = location.hash.match(/^#map=(.+)$/);
        if (!match) { return; }
        var node = nodeById[decodeURIComponent(match[1])];
        if (!node || !node.visible) { return; }
        select(node);
        setTimeout(function () { if (selectedNode === node) { flyTo(node); } }, 1600);
    }

    /* ------------------------------------------------------------------ */
    /* path finding (BFS over the currently visible graph)                 */
    /* ------------------------------------------------------------------ */
    function findPath(sourceNode, targetNode) {
        if (!sourceNode || !targetNode || !sourceNode.visible || !targetNode.visible) { return null; }
        var prev = {};
        prev[sourceNode.id] = { node: sourceNode, via: null, edge: null };
        var queue = [sourceNode];
        var qi = 0;
        while (qi < queue.length) {
            var current = queue[qi++];
            if (current === targetNode) { break; }
            var adj = adjacency[current.id] || [];
            for (var i = 0; i < adj.length; i++) {
                var next = adj[i].node, viaEdge = adj[i].edge;
                if (!next.visible || !viaEdge.visible) { continue; }
                if (prev[next.id]) { continue; }
                prev[next.id] = { node: next, via: current, edge: viaEdge };
                queue.push(next);
            }
        }
        if (!prev[targetNode.id]) { return null; }
        var pathNodes = [], pathEdges = [];
        var walker = prev[targetNode.id];
        while (walker) {
            pathNodes.unshift(walker.node);
            if (walker.edge) { pathEdges.unshift(walker.edge); }
            walker = walker.via ? prev[walker.via.id] : null;
        }
        return { nodes: pathNodes, edges: pathEdges };
    }

    function clearPath() {
        if (!pathResult) { return; }
        pathResult = null;
        edges.forEach(function (e) { e.onPath = false; });
        detailsEl.classList.remove('open');
        scheduleFrame();
    }

    function exitPathMode() {
        pathMode = false;
        pathSource = null;
        var btn = document.getElementById('mapBtnPath');
        if (btn) { btn.classList.remove('active'); }
        hideHint();
    }

    function applyPath(sourceNode, targetNode) {
        var found = findPath(sourceNode, targetNode);
        if (!found) {
            showHint('No path between "' + (sourceNode.l || '') + '" and "' + (targetNode.l || '') + '" in the current view', 3500);
            return;
        }
        selectedNode = null;
        multiSelection = [];
        neighborSet = null;
        edges.forEach(function (e) { e.onPath = false; });
        pathResult = { nodeSet: {}, list: found.nodes };
        found.nodes.forEach(function (n) { pathResult.nodeSet[n.id] = true; });
        found.edges.forEach(function (e) { e.onPath = true; });
        layoutMode = 'exposure';
        arrangeExposure();
        updateLensButtons();
        renderPathPanel(found.nodes, found.edges);
        detailsEl.classList.add('open');
        updateDeepLink(null);
        emitMapEvent('azadspi:map-select', mapEventDetail(null));
        userAdjustedView = true;
        fitToView(found.nodes);
        scheduleFrame();
    }

    function renderPathPanel(pathNodes, pathEdges) {
        var hops = pathEdges.length;
        var html = '';
        html += '<div class="mapDetailsHead">';
        html += '<span class="detailSwatch" style="background:' + escapeHtml(colors.accent) + '"></span>';
        html += '<div><h3>Path found</h3>';
        html += '<div class="detailSub">' + escapeHtml(pathNodes[0].l) + ' → ' + escapeHtml(pathNodes[pathNodes.length - 1].l) + ' · ' + hops + ' hop' + (hops === 1 ? '' : 's') + '</div>';
        html += '</div>';
        html += '<button type="button" class="mapDetailsClose" aria-label="Close">×</button>';
        html += '</div>';
        html += '<div class="mapDetailsBody"><h4>Steps</h4><div class="neighborList">';
        pathNodes.forEach(function (n, idx) {
            html += '<button type="button" data-node="' + escapeHtml(n.id) + '">';
            html += '<span class="nDot" style="background:' + escapeHtml(nodeColor(n)) + '"></span>';
            html += '<span>' + escapeHtml(n.l) + '</span>';
            html += '<span class="nKind">' + escapeHtml((TYPE_CONFIG[n.t] || {}).label || n.t) + '</span>';
            html += '</button>';
            if (idx < pathEdges.length) {
                var edge = pathEdges[idx];
                html += '<div style="padding:0 8px 0 24px;color:var(--ink-3);font-size:11px">↓ ' + escapeHtml(EDGE_KIND_LABEL[edge.k] || edge.k) + (edge.l ? ' (' + escapeHtml(edge.l) + ')' : '') + '</div>';
            }
        });
        html += '</div></div>';
        detailsEl.innerHTML = html;
        detailsEl.querySelector('.mapDetailsClose').addEventListener('click', clearPath);
        detailsEl.querySelectorAll('button[data-node]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var next = nodeById[btn.getAttribute('data-node')];
                if (next && next.visible) { select(next); flyTo(next); }
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /* hint bubble                                                         */
    /* ------------------------------------------------------------------ */
    function showHint(text, autoHideMs) {
        if (!hintEl) { return; }
        hintEl.textContent = text;
        hintEl.classList.add('visible');
        if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
        if (autoHideMs) { hintTimer = setTimeout(hideHint, autoHideMs); }
    }

    function hideHint() {
        if (hintEl) { hintEl.classList.remove('visible'); }
        if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    }

    /* ------------------------------------------------------------------ */
    /* export (current filtered view)                                      */
    /* ------------------------------------------------------------------ */
    function exportPng() {
        var tmp = document.createElement('canvas');
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        var tctx = tmp.getContext('2d');
        tctx.fillStyle = colors.page || '#ffffff';
        tctx.fillRect(0, 0, tmp.width, tmp.height);
        tctx.drawImage(canvas, 0, 0);
        var link = document.createElement('a');
        link.download = 'permission-map.png';
        link.href = tmp.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function exportJson() {
        var data = { exportedAt: new Date().toISOString(), view: 'currently visible nodes/edges (filters applied)', nodes: [], edges: [] };
        nodes.forEach(function (n) {
            if (!n.visible) { return; }
            data.nodes.push({ id: n.id, t: n.t, l: n.l, sub: n.sub || null, r: n.r || null, degree: n.degree, m: n.m || null });
        });
        edges.forEach(function (e) {
            if (!e.visible) { return; }
            data.edges.push({ s: e.s, d: e.d, k: e.k, l: e.l || null, r: e.r || null });
        });
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var link = document.createElement('a');
        link.download = 'permission-map.json';
        link.href = URL.createObjectURL(blob);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(link.href); }, 5000);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showHint('IDs copied to clipboard', 1800);
            }, function () { fallbackCopyText(text); });
            return;
        }
        fallbackCopyText(text);
    }

    function fallbackCopyText(text) {
        var input = document.createElement('textarea');
        input.value = text;
        input.setAttribute('readonly', 'readonly');
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        document.body.appendChild(input);
        input.select();
        try {
            document.execCommand('copy');
            showHint('IDs copied to clipboard', 1800);
        } catch (e) { showHint('Copy failed; select the ID in Details', 2600); }
        document.body.removeChild(input);
    }

    function copyNodeIds(node) {
        var m = node.m || {}, lines = [];
        if (m.objectId) { lines.push('Object ID: ' + m.objectId); }
        if (m.appId) { lines.push('App (client) ID: ' + m.appId); }
        if (!lines.length) { lines.push('Map ID: ' + node.id); }
        copyText(lines.join('\n'));
    }

    function openNodeInEntra(node) {
        var objectId = node.m && node.m.objectId;
        if (!objectId) { return; }
        var url = 'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/DirectoryObjectMenuBlade/~/Overview/objectId/' + encodeURIComponent(objectId);
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    function copyMultiIds() {
        var lines = [];
        multiSelection.forEach(function (node) {
            var m = node.m || {};
            lines.push((node.l || node.id) + ': ' + (m.objectId || m.appId || node.id));
        });
        copyText(lines.join('\n'));
    }

    function renderMultiDetails() {
        if (!multiSelection.length) { return; }
        var html = '';
        html += '<div class="mapDetailsHead"><span class="detailSwatch" style="background:' + escapeHtml(colors.accent) + '"></span>';
        html += '<div><h3>' + multiSelection.length + ' nodes selected</h3><div class="detailSub">Ctrl/Cmd-click nodes to add or remove them</div></div>';
        html += '<button type="button" class="mapDetailsClose" aria-label="Close">×</button></div>';
        html += '<div class="mapDetailsBody"><div class="mapActionRow">';
        html += '<button type="button" class="mapAction" data-multi-action="fit">Fit selected</button>';
        html += '<button type="button" class="mapAction" data-multi-action="findings">Show related findings</button>';
        html += '<button type="button" class="mapAction" data-multi-action="tables">Show related tables</button>';
        html += '<button type="button" class="mapAction" data-multi-action="copy">Copy IDs</button>';
        html += '<button type="button" class="mapAction" data-multi-action="clear">Clear selection</button></div>';
        html += '<h4>Selection</h4><div class="neighborList multiSelectionList">';
        multiSelection.slice(0, 40).forEach(function (n) {
            html += '<button type="button" data-node="' + escapeHtml(n.id) + '"><span class="nDot" style="background:' + escapeHtml(nodeColor(n)) + '"></span>';
            html += '<span>' + escapeHtml(n.l) + '</span><span class="nKind">' + escapeHtml((TYPE_CONFIG[n.t] || {}).label || n.t) + '</span></button>';
        });
        if (multiSelection.length > 40) { html += '<div class="neighborMore">+ ' + (multiSelection.length - 40) + ' more…</div>'; }
        html += '</div></div>';
        detailsEl.innerHTML = html;
        detailsEl.querySelector('.mapDetailsClose').addEventListener('click', function () { select(null); });
        detailsEl.querySelectorAll('button[data-node]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var node = nodeById[btn.getAttribute('data-node')];
                if (node) { select(node); flyTo(node); }
            });
        });
        detailsEl.querySelectorAll('button[data-multi-action]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var action = btn.getAttribute('data-multi-action');
                if (action === 'fit') { fitToView(multiSelection); }
                else if (action === 'findings') { emitMapEvent('azadspi:show-findings', multiMapEventDetail()); }
                else if (action === 'tables') { emitMapEvent('azadspi:show-related', multiMapEventDetail()); }
                else if (action === 'copy') { copyMultiIds(); }
                else if (action === 'clear') { select(null); }
            });
        });
    }

    function renderDetails(node) {
        var cfg = TYPE_CONFIG[node.t] || TYPE_CONFIG.app;
        var changeType = nodeChangeType(node);
        var html = '';
        html += '<div class="mapDetailsHead">';
        html += '<span class="detailSwatch" style="background:' + escapeHtml(nodeColor(node)) + '"></span>';
        html += '<div><h3>' + escapeHtml(node.l) + '</h3>';
        html += '<div class="detailSub">' + escapeHtml(node.sub || cfg.label) + '</div>';
        if (node.r === 'critical') { html += '<div style="margin-top:6px"><span class="riskBadge critical">critical</span></div>'; }
        else if (node.r === 'medium') { html += '<div style="margin-top:6px"><span class="riskBadge medium">medium</span></div>'; }
        if (changeType) {
            html += '<div style="margin-top:6px"><span class="riskBadge" style="background:' + escapeHtml(changeColor(changeType)) + ';color:#fff">' + escapeHtml(changeType) + ' since previous snapshot</span></div>';
        }
        html += '</div>';
        html += '<button type="button" class="mapDetailsClose" aria-label="Close">×</button>';
        html += '</div>';
        html += '<div class="mapDetailsBody">';

        var m = node.m || {};

        /* Contextual investigation and table-integration actions. */
        html += '<div class="mapActionRow">';
        if (node._aggregate) {
            html += '<button type="button" class="mapAction" data-action="expand-external">Expand ' + escapeHtml(m.aggregateCount) + ' identities</button>';
        }
        else {
            html += '<button type="button" class="mapAction" data-action="isolate">Isolate neighborhood</button>';
            if (investigationRoot) {
                html += '<button type="button" class="mapAction" data-action="expand">Expand one hop</button>';
                html += '<button type="button" class="mapAction" data-action="restore">Restore map</button>';
            }
            html += '<button type="button" class="mapAction" data-action="path">Find path from here</button>';
            html += '<button type="button" class="mapAction" data-action="findings">Show related findings</button>';
            html += '<button type="button" class="mapAction" data-action="tables">Show related tables</button>';
            html += '<button type="button" class="mapAction" data-action="hide-type">Hide this node type</button>';
            html += '<button type="button" class="mapAction" data-action="pin">' + (node.pinned ? 'Unpin position' : 'Pin position') + '</button>';
            html += '<button type="button" class="mapAction" data-action="copy">Copy IDs</button>';
            if (m.objectId) { html += '<button type="button" class="mapAction" data-action="entra">Open in Entra</button>'; }
        }
        html += '</div>';

        /* stale identity callout */
        if (m.stale) {
            html += '<div class="staleCallout"><div class="staleCalloutTitle">⚠ Stale identity candidate</div>';
            if (m.staleReasons && m.staleReasons.length) {
                html += '<ul class="staleReasons">';
                m.staleReasons.forEach(function (reason) { html += '<li>' + escapeHtml(reason) + '</li>'; });
                html += '</ul>';
            }
            html += '<div class="staleHintText">Confirm with the owner, then disable before soft-deleting.</div></div>';
        }

        /* properties */
        var rows = '';
        Object.keys(m).forEach(function (key) {
            var val = m[key];
            if (val === null || val === undefined || val === '') { return; }
            if (key === 'aadRoles' || key === 'sponsors' || key === 'noSponsor' || key === 'sponsorsUnavailable' || key === 'stale' || key === 'staleReasons' || key === 'aggregate' || key === 'change' || key === 'changeType') { return; }
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

        if (node.t === 'agent') {
            html += '<h4>Sponsors</h4><div class="neighborList">';
            if (m.sponsors && m.sponsors.length) {
                m.sponsors.forEach(function (sponsor) {
                    html += '<div style="padding:3px 8px;font-size:12.5px">' + escapeHtml(sponsor.name) + (sponsor.type ? ' <span style="color:var(--ink-3);font-size:10.5px">(' + escapeHtml(sponsor.type) + ')</span>' : '') + '</div>';
                });
            }
            else if (m.sponsorsUnavailable) {
                html += '<div style="padding:3px 8px;font-size:12.5px;color:var(--ink-3)">Sponsor data unavailable for this collection.</div>';
            }
            else if (m.noSponsor) {
                html += '<div style="padding:3px 8px;font-size:12.5px"><span class="riskBadge medium">no sponsor assigned</span></div>';
            }
            else { html += '<div style="padding:3px 8px;font-size:12.5px;color:var(--ink-3)">No sponsor data reported.</div>'; }
            html += '</div>';
        }

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
            if (!adj.edge.visible || !adj.node.visible) { return; }
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
        detailsEl.querySelectorAll('button[data-action]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var action = btn.getAttribute('data-action');
                if (action === 'isolate') { activateInvestigation(node, 1); }
                else if (action === 'expand') { expandInvestigation(); }
                else if (action === 'restore') { restoreInvestigation(); }
                else if (action === 'path') {
                    pathMode = true;
                    pathSource = node;
                    var pathBtn = document.getElementById('mapBtnPath');
                    if (pathBtn) { pathBtn.classList.add('active'); }
                    showHint('Path: "' + (node.l || '') + '" is the start - click the target node (Esc to cancel)');
                }
                else if (action === 'findings') { emitMapEvent('azadspi:show-findings', mapEventDetail(node)); }
                else if (action === 'tables') { emitMapEvent('azadspi:show-related', mapEventDetail(node)); }
                else if (action === 'hide-type') {
                    var groupKey = nodeFilterGroup(node);
                    if (groupKey) { typeFilter[groupKey] = false; }
                    applyFilters();
                    syncFilterChips();
                }
                else if (action === 'pin') {
                    node.pinned = !node.pinned;
                    node.vx = 0; node.vy = 0;
                    renderDetails(node);
                    showHint(node.pinned ? 'Node position pinned' : 'Node position released', 1800);
                }
                else if (action === 'copy') { copyNodeIds(node); }
                else if (action === 'entra') { openNodeInEntra(node); }
                else if (action === 'expand-external') {
                    externalExpandedGroups[node.id] = true;
                    select(null);
                    applyFilters();
                    syncFilterChips();
                    fitToView();
                    showHint(m.aggregateCount + ' low-risk external identities expanded', 2600);
                }
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
        var changeType = nodeChangeType(node);
        if (changeType) { html += '<div class="tipRisk" style="color:' + escapeHtml(changeColor(changeType)) + '">' + escapeHtml(changeType) + ' since previous snapshot</div>'; }
        if (node._aggregate) { html += '<div class="tipSub">Click to safely expand low-value external identities</div>'; }
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

        resultsEl.setAttribute('role', 'listbox');
        resultsEl.setAttribute('aria-label', 'Permission map search results');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-controls', resultsEl.id);
        input.setAttribute('aria-expanded', 'false');

        function closeResults() {
            resultsEl.classList.remove('open');
            resultsEl.innerHTML = '';
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }

        function setActiveSearchResult(buttons, index) {
            buttons.forEach(function (button, buttonIndex) {
                var active = buttonIndex === index;
                button.classList.toggle('hover', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
                if (active) {
                    input.setAttribute('aria-activedescendant', button.id);
                    button.scrollIntoView({ block: 'nearest' });
                }
            });
        }

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
            input.setAttribute('aria-expanded', 'true');
            resultsEl.querySelectorAll('button[data-node]').forEach(function (btn, index) {
                btn.id = 'mapSearchOption-' + index;
                btn.setAttribute('role', 'option');
                btn.setAttribute('aria-selected', 'false');
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
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                var buttons = Array.prototype.slice.call(resultsEl.querySelectorAll('button[data-node]'));
                var activeId = input.getAttribute('aria-activedescendant');
                var activeIndex = -1;
                buttons.forEach(function (button, buttonIndex) {
                    if (button.id === activeId) { activeIndex = buttonIndex; }
                });
                if (!buttons.length) { return; }
                ev.preventDefault();
                if (ev.key === 'ArrowDown') { activeIndex = Math.min(buttons.length - 1, activeIndex + 1); }
                else { activeIndex = activeIndex <= 0 ? buttons.length - 1 : activeIndex - 1; }
                setActiveSearchResult(buttons, activeIndex);
            }
            if (ev.key === 'Enter') {
                var active = input.getAttribute('aria-activedescendant');
                var first = (active && document.getElementById(active)) || resultsEl.querySelector('button[data-node]');
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
        html += '<span style="width:1px;height:20px;background:var(--hairline);margin:0 2px"></span>';
        Object.keys(edgeKindFilter).sort().forEach(function (kind) {
            var count = edges.filter(function (e) { return e.k === kind; }).length;
            html += '<button type="button" class="mapChip" data-edge="' + escapeHtml(kind) + '" data-shape="circle" style="--chip-color:var(--map-edge)" title="Toggle ' + escapeHtml(EDGE_KIND_LABEL[kind] || kind) + ' relationships">' +
                '<span class="chipDot"></span>' + escapeHtml(EDGE_KIND_LABEL[kind] || kind) + ' <span style="opacity:.6">' + count + '</span></button>';
        });
        html += '<span style="width:1px;height:20px;background:var(--hairline);margin:0 2px"></span>';
        var staleCount = nodes.filter(function (n) { return n.m && n.m.stale; }).length;
        if (staleCount) {
            html += '<button type="button" class="mapChip off" data-special="stale" data-shape="circle" style="--chip-color:var(--risk-medium-fill)" title="Show only stale identity candidates">' +
                '<span class="chipDot"></span>Stale only <span style="opacity:.6">' + staleCount + '</span></button>';
        }
        html += '<button type="button" class="mapChip off" data-special="unconnected" data-shape="circle" style="--chip-color:var(--ink-3)" title="Hide nodes without any visible connection">' +
            '<span class="chipDot"></span>Hide unconnected</button>';
        if (externalAggregates.length) {
            var aggregateTotal = externalAggregates.reduce(function (sum, n) { return sum + n.m.aggregateCount; }, 0);
            html += '<button type="button" class="mapChip off" data-special="external" data-shape="circle" style="--chip-color:var(--map-appext)" title="Expand or collapse unflagged external service principals with no governed relationships">' +
                '<span class="chipDot"></span>Expand external noise <span style="opacity:.6">' + aggregateTotal + '</span></button>';
        }
        filtersEl.innerHTML = html;

        filtersEl.querySelectorAll('.mapChip').forEach(function (chip) {
            chip.addEventListener('click', function () {
                var fkey = chip.getAttribute('data-filter');
                var rkey = chip.getAttribute('data-risk');
                var ekey = chip.getAttribute('data-edge');
                var skey = chip.getAttribute('data-special');
                if (fkey) { typeFilter[fkey] = !typeFilter[fkey]; chip.classList.toggle('off', !typeFilter[fkey]); }
                if (rkey) { riskFilter[rkey] = !riskFilter[rkey]; chip.classList.toggle('off', !riskFilter[rkey]); }
                if (ekey) { edgeKindFilter[ekey] = !edgeKindFilter[ekey]; chip.classList.toggle('off', !edgeKindFilter[ekey]); }
                if (skey === 'unconnected') { hideUnconnected = !hideUnconnected; chip.classList.toggle('off', !hideUnconnected); }
                if (skey === 'stale') { staleOnly = !staleOnly; chip.classList.toggle('off', !staleOnly); }
                if (skey === 'external') {
                    externalExpanded = !externalExpanded;
                    if (!externalExpanded) { externalExpandedGroups = {}; }
                    chip.classList.toggle('off', !externalExpanded);
                }
                applyFilters();
                syncFilterChips();
            });
        });
        syncFilterChips();
    }

    function syncFilterChips() {
        var filtersEl = document.getElementById('mapFilters');
        if (!filtersEl) { return; }
        filtersEl.querySelectorAll('.mapChip').forEach(function (chip) {
            var fkey = chip.getAttribute('data-filter');
            var rkey = chip.getAttribute('data-risk');
            var ekey = chip.getAttribute('data-edge');
            var skey = chip.getAttribute('data-special');
            if (fkey) { chip.classList.toggle('off', !typeFilter[fkey]); }
            if (rkey) { chip.classList.toggle('off', !riskFilter[rkey]); }
            if (ekey) { chip.classList.toggle('off', !edgeKindFilter[ekey]); }
            if (skey === 'unconnected') { chip.classList.toggle('off', !hideUnconnected); }
            if (skey === 'stale') { chip.classList.toggle('off', !staleOnly); }
            if (skey === 'external') { chip.classList.toggle('off', !externalExpanded); }
            chip.setAttribute('aria-pressed', chip.classList.contains('off') ? 'false' : 'true');
        });
    }

    function initButtons() {
        var btnFit = document.getElementById('mapBtnFit');
        var btnZoomIn = document.getElementById('mapBtnZoomIn');
        var btnZoomOut = document.getElementById('mapBtnZoomOut');
        var btnLayout = document.getElementById('mapBtnLayout');
        var btnFull = document.getElementById('mapBtnFullscreen');

        /* analysis buttons are injected so the generated markup stays unchanged */
        var buttonsRow = sectionEl.querySelector('.mapButtons');
        if (buttonsRow) {
            function injectBtn(id, label, title) {
                var existing = document.getElementById(id);
                if (existing) { return existing; }
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'mapBtn';
                b.id = id;
                b.textContent = label;
                b.title = title;
                if (btnFull) { buttonsRow.insertBefore(b, btnFull); } else { buttonsRow.appendChild(b); }
                return b;
            }
            var btnOverview = injectBtn('mapBtnOverview', 'Overview', 'Cluster the map by identity and permission type');
            var btnInvestigation = injectBtn('mapBtnInvestigation', 'Investigation', 'Isolate the selected identity and its immediate neighborhood');
            var btnExposure = injectBtn('mapBtnExposure', 'Exposure', 'Layer principals, identities, permissions, and resources');
            var btnPath = injectBtn('mapBtnPath', 'Path', 'Find the shortest path between two nodes');
            var btnPng = injectBtn('mapBtnPng', 'PNG', 'Export the current view as PNG image');
            var btnJson = injectBtn('mapBtnJson', 'JSON', 'Export the currently visible nodes/edges as JSON');
            btnOverview.addEventListener('click', function () { setLayoutMode('overview'); });
            btnInvestigation.addEventListener('click', function () { setLayoutMode('investigation'); });
            btnExposure.addEventListener('click', function () { setLayoutMode('exposure'); });
            btnPath.addEventListener('click', function () {
                if (pathMode) { exitPathMode(); return; }
                pathMode = true;
                pathSource = selectedNode || null;
                btnPath.classList.add('active');
                if (pathSource) { showHint('Path: "' + (pathSource.l || '') + '" is the start - click the target node (Esc to cancel)'); }
                else { showHint('Path: click the start node, then the target node (Esc to cancel)'); }
            });
            btnPng.addEventListener('click', exportPng);
            btnJson.addEventListener('click', exportJson);
            updateLensButtons();
        }
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
        var shapes = { circle: 'circle', circleOutline: 'ring', dot: 'dot', ring: 'ring', square: 'square', squareOutline: 'square', diamond: 'diamond', hex: 'hex', star: 'star', triangle: 'triangle', triangleOutline: 'triangle' };
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
                if (pathMode) {
                    if (hit && !pathSource) {
                        pathSource = hit;
                        showHint('Path: "' + (hit.l || '') + '" selected as start - now click the target node (Esc to cancel)');
                    }
                    else if (hit && hit !== pathSource) {
                        var pathFrom = pathSource;
                        exitPathMode();
                        applyPath(pathFrom, hit);
                    }
                }
                else {
                    clearPath();
                    if (hit && (ev.ctrlKey || ev.metaKey)) { toggleMultiSelection(hit); }
                    else { select(hit || null); }
                }
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
                if (pathMode) { exitPathMode(); return; }
                if (sectionEl.classList.contains('azadspiFullscreen')) {
                    sectionEl.classList.remove('azadspiFullscreen');
                    var btnFull = document.getElementById('mapBtnFullscreen');
                    if (btnFull) { btnFull.textContent = '⛶'; }
                    resize();
                }
                clearPath();
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
        resizeMiniMap();
        scheduleFrame();
    }

    /* ------------------------------------------------------------------ */
    /* bootstrap                                                           */
    /* ------------------------------------------------------------------ */
    function init() {
        if (initialized) { return; }
        sectionEl = document.getElementById('identityMap');
        var dataEl = document.getElementById('azadspiMapData');
        if (!sectionEl) { return; }
        stageEl = sectionEl.querySelector('.mapStage');
        canvas = document.getElementById('mapCanvas');
        tooltipEl = sectionEl.querySelector('.mapTooltip');
        detailsEl = document.getElementById('mapDetails');
        if (!stageEl || !canvas) { return; }
        initialized = true;

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
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'Interactive permission relationship map. Use the search field and filters to select identities and inspect connections.');
        resolveColors();
        prepare(data);
        applyFiltersInitialState();
        initSearch();
        initFilters();
        initButtons();
        initLegend();
        initPointer();
        initMiniMap();

        hintEl = document.createElement('div');
        hintEl.className = 'mapHint';
        stageEl.appendChild(hintEl);

        resize();
        window.addEventListener('resize', resize);
        document.addEventListener('azadspi:themechange', function () {
            resolveColors();
            scheduleFrame();
        });
        document.addEventListener('azadspi:focus-node', function (event) {
            var detail = event.detail;
            if (typeof detail === 'string') { detail = { id: detail }; }
            focusNode(findNodeByReference(detail));
        });

        alphaTarget = 0;
        alpha = 1;
        simRunning = true;
        scheduleFrame();
        applyDeepLink();
    }

    function applyFiltersInitialState() {
        nodes.forEach(function (n) {
            n.visible = n._aggregate ? true : !lowValueExternal[n.id];
            n._baseVisible = n.visible;
        });
        edges.forEach(function (e) { e.visible = e.sn.visible && e.dn.visible; });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AzADSPIMap = {
        reinit: init,
        selectById: function (id) {
            var node = nodeById[id];
            if (node && node.visible) { select(node); flyTo(node); return true; }
            return false;
        },
        pathBetween: function (sourceId, targetId) {
            var src = nodeById[sourceId], dst = nodeById[targetId];
            if (!src || !dst) { return false; }
            applyPath(src, dst);
            return !!pathResult;
        }
    };
})();
