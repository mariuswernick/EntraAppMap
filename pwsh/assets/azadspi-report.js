/* AzADServicePrincipalInsights - report behaviors (self-contained, replaces azadvertizer toggle/collapsetable scripts) */
(function () {
    'use strict';

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* ---------------------------------------------------------------
       Theme handling. The <head> bootstrap script stamps data-theme
       before first paint; this wires the toggle button + chart retheme.
       --------------------------------------------------------------- */
    function currentTheme() {
        var stamped = document.documentElement.getAttribute('data-theme');
        if (stamped === 'dark' || stamped === 'light') { return stamped; }
        return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('azadspiTheme', theme); } catch (e) { /* private mode */ }
        var btn = document.querySelector('.azadspiThemeToggle');
        if (btn) { btn.textContent = theme === 'dark' ? '☀' : '☾'; }
        rethemeCharts();
        document.dispatchEvent(new CustomEvent('azadspi:themechange', { detail: { theme: theme } }));
    }

    function chartInstances() {
        var instances = [];
        if (typeof Chart === 'undefined' || !Chart.instances) { return instances; }
        Object.keys(Chart.instances).forEach(function (key) {
            if (Chart.instances[key]) { instances.push(Chart.instances[key]); }
        });
        return instances;
    }

    function chartLabel(label) {
        var value = String(label == null ? '' : label);
        if (value === '!notesN/A && !notesNotSet') { return 'Notes present'; }
        if (value === 'notesNotSet') { return 'Notes missing'; }
        return value;
    }

    function chartColor(styles, label, index) {
        var value = String(label || '').toLowerCase();
        var property;
        var palette = ['--accent', '--cat-mi', '--risk-medium', '--map-appext', '--cat-agent', '--risk-critical'];
        if (/expired|without owner|missing|not set/.test(value)) { property = '--risk-critical'; }
        else if (/expire soon|warning/.test(value)) { property = '--risk-medium'; }
        else if (/with owner|present|valid/.test(value)) { property = '--good'; }
        else { property = palette[index % palette.length]; }
        return styles.getPropertyValue(property).trim() || '#3987e5';
    }

    function modernizeCharts() {
        var originals;
        if (typeof Chart === 'undefined') { return; }
        originals = chartInstances();
        originals.forEach(function (chart) {
            var originalData;
            var originalOptions;
            var originalClick;
            var originalTooltip;
            var labels = [];
            var values = [];
            var mappings = [];
            var canvas;
            var card;
            var plot;
            var summary;
            var total = 0;
            var topIndex = 0;
            var modern;
            if (!chart || chart.$azadspiModernized || !chart.canvas) { return; }
            originalData = chart.config && chart.config.data ? chart.config.data : chart.data;
            originalOptions = chart.options || {};
            originalClick = originalOptions.onClick;
            originalTooltip = originalOptions.tooltips && originalOptions.tooltips.callbacks
                ? originalOptions.tooltips.callbacks.label : null;
            (originalData.datasets || []).forEach(function (dataset, datasetIndex) {
                (dataset.data || []).forEach(function (rawValue, dataIndex) {
                    var originalLabel = dataset.labels && dataset.labels[dataIndex] != null
                        ? dataset.labels[dataIndex]
                        : ((originalData.labels || [])[dataIndex] || ('Category ' + (dataIndex + 1)));
                    var value = Number(rawValue) || 0;
                    labels.push(chartLabel(originalLabel));
                    values.push(value);
                    mappings.push({ datasetIndex: datasetIndex, dataIndex: dataIndex });
                    total += value;
                    if (value > values[topIndex]) { topIndex = values.length - 1; }
                });
            });
            if (!labels.length) { return; }
            canvas = chart.canvas;
            card = canvas.closest ? canvas.closest('.chartDiv') : canvas.parentNode;
            if (card) {
                card.classList.add('azadspiDistributionCard');
                var title = card.querySelector('span');
                if (title) { title.classList.add('azadspiChartTitle'); }
                summary = document.createElement('div');
                summary.className = 'azadspiChartSummary';
                summary.innerHTML = '<strong>' + values[topIndex] + '</strong><span title="' + escapeHtml(labels[topIndex]) + '">' + escapeHtml(labels[topIndex]) + '</span><small>top category · ' + total + ' total</small>';
                plot = document.createElement('div');
                plot.className = 'azadspiChartPlot';
                plot.style.height = Math.max(150, labels.length * 29 + 34) + 'px';
                card.insertBefore(summary, canvas);
                card.insertBefore(plot, canvas);
                plot.appendChild(canvas);
            }
            canvas.removeAttribute('style');
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', ((card && card.querySelector('.azadspiChartTitle')) ? textOf(card.querySelector('.azadspiChartTitle')) : 'Inventory') + ' ranked distribution');
            try { chart.destroy(); } catch (e) { /* recreate in place */ }
            modern = new Chart(canvas, {
                type: 'horizontalBar',
                data: {
                    labels: labels,
                    datasets: [{
                        data: values,
                        backgroundColor: labels.map(function () { return '#3987e5'; }),
                        borderWidth: 0,
                        barPercentage: 0.72,
                        categoryPercentage: 0.82
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 220 },
                    legend: { display: false },
                    layout: { padding: { left: 0, right: 16, top: 2, bottom: 0 } },
                    scales: {
                        xAxes: [{ ticks: { beginAtZero: true, precision: 0, fontSize: 10 }, gridLines: { drawBorder: false } }],
                        yAxes: [{
                            ticks: {
                                fontSize: 11,
                                callback: function (value) {
                                    value = String(value);
                                    return value.length > 28 ? value.slice(0, 18) + '…' + value.slice(-6) : value;
                                }
                            },
                            gridLines: { display: false, drawBorder: false }
                        }]
                    },
                    tooltips: {
                        displayColors: false,
                        callbacks: {
                            label: function (tooltipItem, data) {
                                var value = Number(data.datasets[0].data[tooltipItem.index]) || 0;
                                var percent = total ? Math.round((value / total) * 100) : 0;
                                return data.labels[tooltipItem.index] + ': ' + value + ' (' + percent + '%)';
                            }
                        }
                    },
                    onClick: function (event, elements) {
                        var mapping;
                        if (!elements || !elements.length) { return; }
                        mapping = mappings[elements[0]._index];
                        if (originalTooltip) {
                            originalTooltip({ datasetIndex: mapping.datasetIndex, index: mapping.dataIndex }, originalData);
                        }
                        if (originalClick) { originalClick(event, elements); }
                    }
                }
            });
            modern.$azadspiModernized = true;
            modern.$azadspiLabels = labels;
        });
    }

    function rethemeCharts() {
        if (typeof Chart === 'undefined') { return; }
        var styles = getComputedStyle(document.documentElement);
        var ink = styles.getPropertyValue('--ink-2').trim() || '#52514e';
        var muted = styles.getPropertyValue('--ink-3').trim() || '#898781';
        var hairline = styles.getPropertyValue('--hairline').trim() || '#e1e0d9';
        var font = styles.getPropertyValue('--font').trim() || 'system-ui, sans-serif';
        if (Chart.defaults && Chart.defaults.global) {
            Chart.defaults.global.defaultFontColor = ink;
            Chart.defaults.global.defaultFontFamily = font;
        }
        chartInstances().forEach(function (chart) {
            try {
                if (chart.$azadspiLabels && chart.data && chart.data.datasets[0]) {
                    chart.data.datasets[0].backgroundColor = chart.$azadspiLabels.map(function (label, index) {
                        return chartColor(styles, label, index);
                    });
                }
                if (chart.options && chart.options.scales) {
                    (chart.options.scales.xAxes || []).forEach(function (axis) {
                        axis.ticks.fontColor = muted;
                        axis.gridLines.color = hairline;
                        axis.gridLines.zeroLineColor = hairline;
                    });
                    (chart.options.scales.yAxes || []).forEach(function (axis) {
                        axis.ticks.fontColor = ink;
                    });
                }
                chart.update();
            } catch (e) { /* chart may be detached */ }
        });
    }

    function initThemeToggle() {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'azadspiThemeToggle';
        btn.title = 'Toggle light/dark theme';
        btn.setAttribute('aria-label', 'Toggle light/dark theme');
        btn.textContent = currentTheme() === 'dark' ? '☀' : '☾';
        btn.addEventListener('click', function () {
            applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
        });
        document.body.appendChild(btn);
    }

    /* ---------------------------------------------------------------
       Collapsible sections:
       - button.collapsible toggles the immediately following .content
       - button.decollapsible toggles the following .showContent block
       --------------------------------------------------------------- */
    function initCollapsibles() {
        var seenIds = {};
        var sectionNumber = 0;
        document.querySelectorAll('button.collapsible, button.nonCollapsible').forEach(function (btn) {
            var baseId = btn.id || 'azadspiSection';
            var count = seenIds[baseId] || 0;
            seenIds[baseId] = count + 1;
            if (count > 0 || document.querySelectorAll('#' + baseId).length > 1) {
                btn.id = baseId + '-' + (count + 1);
            }
        });
        document.querySelectorAll('button.collapsible').forEach(function (btn) {
            var panel = btn.nextElementSibling;
            sectionNumber++;
            if (panel && panel.classList.contains('content')) {
                if (!panel.id) { panel.id = 'azadspiSectionContent-' + sectionNumber; }
                btn.setAttribute('aria-controls', panel.id);
                btn.setAttribute('aria-expanded', btn.classList.contains('active') ? 'true' : 'false');
            }
            btn.addEventListener('click', function () {
                btn.classList.toggle('active');
                btn.setAttribute('aria-expanded', btn.classList.contains('active') ? 'true' : 'false');
            });
        });
        document.querySelectorAll('button.decollapsible').forEach(function (btn) {
            var initialTarget = btn.nextElementSibling;
            while (initialTarget && !initialTarget.classList.contains('showContent')) {
                initialTarget = initialTarget.nextElementSibling;
            }
            if (initialTarget) {
                sectionNumber++;
                if (!initialTarget.id) { initialTarget.id = 'azadspiSectionContent-' + sectionNumber; }
                btn.setAttribute('aria-controls', initialTarget.id);
                btn.setAttribute('aria-expanded', initialTarget.classList.contains('azadspiHidden') ? 'false' : 'true');
            }
            btn.addEventListener('click', function () {
                var target = btn.nextElementSibling;
                while (target && !target.classList.contains('showContent')) {
                    target = target.nextElementSibling;
                }
                if (target) {
                    target.classList.toggle('azadspiHidden');
                    btn.setAttribute('aria-expanded', target.classList.contains('azadspiHidden') ? 'false' : 'true');
                }
            });
        });
    }

    /* ---------------------------------------------------------------
       Loader overlay fade-out
       --------------------------------------------------------------- */
    function hideLoader() {
        document.querySelectorAll('.se-pre-con').forEach(function (el) {
            el.style.transition = 'opacity 0.4s ease';
            el.style.opacity = '0';
            setTimeout(function () { el.style.display = 'none'; }, 450);
        });
    }

    /* ---------------------------------------------------------------
       Investigation workspace and progressive table enhancement.
       The report generator has several table shapes, so this layer uses
       header/data heuristics and never changes existing column indexes.
       --------------------------------------------------------------- */
    var tableStates = [];
    var tableStateById = {};
    var rowsByNodeId = {};
    var mapData = { nodes: [], edges: [], stats: {} };
    var mapNodesById = {};
    var mapNodesByToken = {};
    var findings = [];
    var findingKeys = {};
    var activePreset = 'all';
    var globalQuery = '';
    var mapSelectionLabel = '';
    var mapSelectionTokens = [];
    var queryBeforeMapSelection = '';
    var workspaceElements = {};
    var drawer = null;
    var generatedTableId = 0;
    var restoredUrlState = {};
    var activeTableState = null;

    function each(list, fn) {
        Array.prototype.forEach.call(list || [], fn);
    }

    function textOf(el) {
        return el ? String(el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim() : '';
    }

    function normalized(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function shortText(value, length) {
        var clean = String(value || '').replace(/\s+/g, ' ').trim();
        return clean.length > length ? clean.slice(0, length - 1) + '\u2026' : clean;
    }

    function make(tag, className, text) {
        var el = document.createElement(tag);
        if (className) { el.className = className; }
        if (text !== undefined && text !== null) { el.textContent = text; }
        return el;
    }

    function emit(name, detail) {
        var event;
        if (typeof window.CustomEvent === 'function') {
            event = new CustomEvent(name, { detail: detail });
        } else {
            event = document.createEvent('CustomEvent');
            event.initCustomEvent(name, false, false, detail);
        }
        document.dispatchEvent(event);
    }

    function readUrlState() {
        var query = String(window.location.search || '').replace(/^\?/, '');
        var state = {};
        if (!query) { return state; }
        query.split('&').forEach(function (part) {
            var split = part.split('=');
            var key;
            try { key = decodeURIComponent(split.shift() || ''); } catch (e) { key = ''; }
            if (key.indexOf('az') !== 0) { return; }
            try { state[key] = decodeURIComponent(split.join('=') || '').replace(/\+/g, ' '); } catch (e) { state[key] = ''; }
        });
        return state;
    }

    function persistUrlState(state) {
        var existing = String(window.location.search || '').replace(/^\?/, '').split('&').filter(function (part) {
            return part && !/^az(?:q|lens|table|tq)=/.test(part);
        });
        var localState = state || activeTableState;
        if (globalQuery) { existing.push('azq=' + encodeURIComponent(globalQuery)); }
        if (activePreset !== 'all') { existing.push('azlens=' + encodeURIComponent(activePreset)); }
        if (localState && localState.localQuery) {
            existing.push('aztable=' + encodeURIComponent(localState.id));
            existing.push('aztq=' + encodeURIComponent(localState.localQuery));
        }
        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, document.title, window.location.pathname + (existing.length ? '?' + existing.join('&') : '') + window.location.hash);
        }
    }

    function loadMapData() {
        var dataEl = document.getElementById('azadspiMapData');
        var i;
        if (dataEl) {
            try { mapData = JSON.parse(dataEl.textContent || '{}'); } catch (e) { mapData = { nodes: [], edges: [], stats: {} }; }
        }
        mapData.nodes = mapData.nodes || [];
        mapData.edges = mapData.edges || [];
        mapData.stats = mapData.stats || {};
        for (i = 0; i < mapData.nodes.length; i++) {
            indexMapNode(mapData.nodes[i]);
        }
    }

    function addMapToken(token, node) {
        var key = String(token || '').trim().toLowerCase();
        if (!key) { return; }
        if (!mapNodesByToken[key]) { mapNodesByToken[key] = []; }
        mapNodesByToken[key].push(node);
    }

    function indexMapNode(node) {
        var meta = node.m || {};
        mapNodesById[node.id] = node;
        addMapToken(node.id, node);
        addMapToken(meta.objectId, node);
        addMapToken(meta.appId, node);
        addMapToken(node.l, node);
    }

    function tableTitle(table) {
        var cursor = table.parentElement;
        var level = 0;
        var previous;
        var heading;
        while (cursor && level < 4) {
            previous = cursor.previousElementSibling;
            if (previous) {
                heading = previous.querySelector ? previous.querySelector('hr[data-content]') : null;
                if (!heading && previous.matches && previous.matches('hr[data-content]')) { heading = previous; }
                if (heading) { return textOfContentAttribute(heading); }
            }
            cursor = cursor.parentElement;
            level++;
        }
        return String(table.id || 'Inventory').replace(/^TenantSummary_/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    function textOfContentAttribute(el) {
        return String(el.getAttribute('data-content') || '').replace(/&nbsp;|\u00a0/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function headerCells(table) {
        var best = [];
        var rows = table.querySelectorAll('thead tr');
        each(rows, function (row) {
            var headers = Array.prototype.slice.call(row.querySelectorAll('th'));
            if (headers.length > best.length) { best = headers; }
        });
        if (best.length) { return best; }
        var fallback = rows[0];
        return fallback ? Array.prototype.slice.call(fallback.cells || []) : [];
    }

    function bodyRows(table) {
        var tbody = table.tBodies && table.tBodies.length ? table.tBodies[0] : table.querySelector('tbody');
        return tbody ? Array.prototype.slice.call(tbody.rows || tbody.querySelectorAll('tr')) : [];
    }

    function headerIndex(state, matcher) {
        var i;
        for (i = 0; i < state.headerNames.length; i++) {
            if (matcher.test(state.headerNames[i])) { return i; }
        }
        return -1;
    }

    function cellValue(row, index) {
        return index >= 0 && row.cells && row.cells[index] ? textOf(row.cells[index]) : '';
    }

    function rowText(row) {
        return textOf(row).toLowerCase();
    }

    function nodeForRow(state, row) {
        var scored = [];
        var i;
        var values;
        var match;
        var candidates;
        for (i = 0; i < state.headerNames.length; i++) {
            values = cellValue(row, i).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig) || [];
            if (!values.length) { continue; }
            match = state.headerNames[i];
            scored.push({
                score: /sp.*object|sp.*aad.*object|managed.*object/.test(match) ? 100 :
                    (/application.*client.*id|sp.*application.*id|sp.*app.*id/.test(match) ? 80 :
                        (/app.*application.*id|blueprint.*app.*id/.test(match) ? 70 :
                            (/user.*id/.test(match) ? 60 : (/owner.*id/.test(match) ? 25 : 10)))),
                values: values
            });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        for (i = 0; i < scored.length; i++) {
            for (var j = 0; j < scored[i].values.length; j++) {
                candidates = mapNodesByToken[scored[i].values[j].toLowerCase()];
                if (candidates && candidates.length) { return candidates[0]; }
            }
        }
        return null;
    }

    function sourceRowForNode(node) {
        var list = node && rowsByNodeId[node.id];
        return list && list.length ? list[0] : null;
    }

    function removeLegacyTableExport(table) {
        var node = table.previousSibling;
        var removable = [];
        var foundExport = false;
        var previous;
        while (node && removable.length < 10) {
            previous = node.previousSibling;
            if (node.nodeType === 3 && /^\s*(?:Download CSV)?\s*(?:\|)?\s*$/.test(node.nodeValue || '')) {
                removable.push(node);
            } else if (node.nodeType === 1 && node.matches && node.matches('a.externallink[onclick*="download_table_as_csv"]')) {
                foundExport = true;
                removable.push(node);
            } else if (node.nodeType === 1 && node.matches && node.matches('div') && node.querySelector('a.externallink[onclick*="download_table_as_csv"]')) {
                foundExport = true;
                removable.push(node);
                break;
            } else if (node.nodeType === 1 && node.matches && node.matches('i.fa-table')) {
                removable.push(node);
                break;
            } else {
                break;
            }
            node = previous;
        }
        if (foundExport) {
            removable.forEach(function (entry) {
                if (entry.parentNode) { entry.parentNode.removeChild(entry); }
            });
        }
    }

    function prepareNativeFilterRow(state) {
        var row = state.table.querySelector('thead tr.fltrow');
        if (!row) { return; }
        row.setAttribute('aria-label', 'Column filters');
        row.parentNode.appendChild(row);
        each(row.querySelectorAll('input, select'), function (control, controlIndex) {
            var columnIndex = parseInt(control.getAttribute('ct'), 10);
            var name;
            var cell = control.closest ? control.closest('td, th') : control.parentNode;
            if (isNaN(columnIndex)) { columnIndex = controlIndex; }
            name = state.headers[columnIndex] ? textOf(state.headers[columnIndex]) : ('column ' + (columnIndex + 1));
            control.setAttribute('aria-label', 'Filter ' + name);
            if (control.tagName === 'INPUT' && control.type !== 'button' && control.type !== 'reset') {
                control.placeholder = 'Filter';
            }
            if (control.tagName === 'SELECT' && control.options && control.options.length && !control.options[0].value) {
                control.options[0].textContent = 'All';
            }
            function reflectFilter() {
                if (cell && cell.classList) {
                    cell.classList.toggle('azadspiFilterActive', !!String(control.value || '').trim());
                }
            }
            control.addEventListener('input', reflectFilter);
            control.addEventListener('change', reflectFilter);
            reflectFilter();
        });
    }

    function decorateDataColumns(state) {
        each(state.headerNames, function (name, index) {
            if (!/(?:^|\s)(?:object|application|client|owner|principal|resource)?\s*id$/.test(name)) { return; }
            state.headers[index].classList.add('azadspiMonoColumn');
            each(state.rows, function (row) {
                if (row.cells && row.cells[index]) { row.cells[index].classList.add('azadspiMonoColumn'); }
            });
        });
    }

    function enhanceTables() {
        each(document.querySelectorAll('table.summaryTable'), function (table) {
            enhanceTable(table);
        });
    }

    function enhanceTable(table) {
        var id;
        var preferredId;
        var state;
        var caption;
        var toolbar;
        var shell;
        var search;
        var status;
        var reset;
        var density;
        var columns;
        var menu;
        var exportBtn;
        var nativeNoResults;
        var emptyState;
        if (table.getAttribute('data-azadspi-enhanced') === 'true') { return; }
        nativeNoResults = table.nextElementSibling && table.nextElementSibling.classList.contains('no-results')
            ? table.nextElementSibling : null;
        removeLegacyTableExport(table);
        table.setAttribute('data-azadspi-enhanced', 'true');
        table.classList.add('azadspiEnhancedTable');
        preferredId = /agent identities/i.test(tableTitle(table)) ? 'TenantSummary_AgentIdentities'
            : (/stale identities/i.test(tableTitle(table)) ? 'TenantSummary_StaleIdentities' : '');
        id = table.id || preferredId;
        if (!id || document.querySelectorAll('#' + id).length > 1) {
            generatedTableId++;
            id = 'azadspiInventoryTable-' + generatedTableId;
        }
        table.id = id;
        state = {
            id: id,
            table: table,
            title: tableTitle(table),
            headers: headerCells(table),
            rows: bodyRows(table),
            headerNames: [],
            sorts: [],
            localQuery: '',
            search: null,
            status: null
        };
        each(state.headers, function (th) {
            th.setAttribute('scope', 'col');
            th.setAttribute('aria-sort', sortDirection(th));
            state.headerNames.push(normalized(textOf(th)));
        });
        caption = table.querySelector('caption');
        if (!caption) {
            caption = make('caption', 'azadspiTableCaption', state.title);
            table.insertBefore(caption, table.firstChild);
        }
        caption.classList.add('azadspiNativeCaption');
        if (!caption.querySelector('.rspg, .pgSlc, .pgInp')) { caption.classList.add('azadspiCaptionRedundant'); }
        var pageSizeLabel = caption.querySelector('.rspgSpan');
        if (pageSizeLabel) { pageSizeLabel.textContent = 'Rows per page '; }
        each(caption.querySelectorAll('.pgInp'), function (pagerButton) {
            pagerButton.style.backgroundImage = 'none';
            if (pagerButton.classList.contains('firstPage')) { pagerButton.value = '«'; }
            else if (pagerButton.classList.contains('previousPage')) { pagerButton.value = '‹'; }
            else if (pagerButton.classList.contains('nextPage')) { pagerButton.value = '›'; }
            else if (pagerButton.classList.contains('lastPage')) { pagerButton.value = '»'; }
        });
        prepareNativeFilterRow(state);
        decorateDataColumns(state);
        each(state.rows, function (row, rowIndex) {
            var node = nodeForRow(state, row);
            row._azadspiOriginalIndex = rowIndex;
            row.tabIndex = -1;
            row.setAttribute('aria-selected', 'false');
            row.setAttribute('data-azadspi-search-text', rowText(row));
            row._azadspiState = state;
            if (node) {
                row._azadspiNode = node;
                row.setAttribute('data-map-node-id', node.id);
                if (node.m && node.m.objectId) { row.setAttribute('data-object-id', node.m.objectId); }
                if (!rowsByNodeId[node.id]) { rowsByNodeId[node.id] = []; }
                rowsByNodeId[node.id].push(row);
            }
            row.addEventListener('click', function (event) {
                if (event.target.closest && event.target.closest('a, button, input, select, label')) { return; }
                selectRow(row, true);
            });
            row.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.keyCode === 13) {
                    event.preventDefault();
                    selectRow(row, true);
                }
            });
        });
        if (state.rows.length) { state.rows[0].tabIndex = 0; }

        toolbar = make('div', 'azadspiTableToolbar');
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', state.title + ' table controls');
        search = make('input', 'azadspiTableSearch');
        search.type = 'search';
        search.placeholder = 'Filter rows…';
        search.setAttribute('aria-label', 'Search ' + state.title);
        state.search = search;
        search.addEventListener('input', function () {
            state.localQuery = search.value.toLowerCase().trim();
            activeTableState = state;
            applyTableSearch(state);
            persistUrlState(state);
        });
        if (restoredUrlState.aztable === state.id && restoredUrlState.aztq) {
            state.localQuery = String(restoredUrlState.aztq).toLowerCase().trim();
            search.value = restoredUrlState.aztq;
            activeTableState = state;
        }
        reset = make('button', 'azadspiToolbarBtn', 'Reset');
        reset.type = 'button';
        reset.addEventListener('click', function () { resetTable(state, search); });
        density = make('button', 'azadspiToolbarBtn', 'Compact');
        density.type = 'button';
        density.setAttribute('aria-pressed', 'false');
        density.addEventListener('click', function () {
            var compact = table.classList.toggle('azadspiDense');
            density.setAttribute('aria-pressed', compact ? 'true' : 'false');
            density.textContent = compact ? 'Comfortable' : 'Compact';
        });
        columns = make('div', 'azadspiColumnPicker');
        var columnsBtn = make('button', 'azadspiToolbarBtn', 'Columns');
        columnsBtn.type = 'button';
        columnsBtn.setAttribute('aria-expanded', 'false');
        menu = make('div', 'azadspiColumnMenu');
        menu.setAttribute('role', 'group');
        menu.setAttribute('aria-label', 'Visible columns');
        columnsBtn.addEventListener('click', function () {
            var open = menu.classList.toggle('is-open');
            columnsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        buildColumnMenu(state, menu);
        initTableSorting(state);
        initColumnResizing(state);
        columns.appendChild(columnsBtn);
        columns.appendChild(menu);
        exportBtn = make('button', 'azadspiToolbarBtn', 'Export CSV');
        exportBtn.type = 'button';
        exportBtn.title = 'Export visible rows as CSV (Shift-click for semicolon delimiter)';
        exportBtn.addEventListener('click', function (event) { exportVisibleRows(state, event.shiftKey ? ';' : ','); });
        var copyBtn = make('button', 'azadspiToolbarBtn', 'Copy row');
        copyBtn.type = 'button';
        copyBtn.addEventListener('click', function () {
            if (state.selectedRow) { copyRow(state, state.selectedRow); }
        });
        status = make('span', 'azadspiTableStatus');
        status.setAttribute('aria-live', 'polite');
        state.status = status;
        toolbar.appendChild(search);
        toolbar.appendChild(reset);
        toolbar.appendChild(density);
        toolbar.appendChild(columns);
        toolbar.appendChild(exportBtn);
        toolbar.appendChild(copyBtn);
        toolbar.appendChild(status);
        shell = make('div', 'azadspiTableShell');
        table.parentNode.insertBefore(shell, table);
        shell.appendChild(toolbar);
        shell.appendChild(table);
        if (nativeNoResults) { shell.appendChild(nativeNoResults); }
        if (!state.rows.length) {
            shell.classList.add('azadspiTableShellEmpty');
            toolbar.hidden = true;
            table.hidden = true;
            if (nativeNoResults) { nativeNoResults.hidden = true; }
            emptyState = make('div', 'azadspiTableEmpty');
            emptyState.setAttribute('role', 'status');
            emptyState.innerHTML = '<span class="azadspiEmptyMark" aria-hidden="true"></span><strong>No records in this section</strong><small>The tenant returned no ' + escapeHtml(state.title.toLowerCase()) + '.</small>';
            shell.appendChild(emptyState);
        }
        shell.addEventListener('input', function () { setTimeout(function () { updateTableStatus(state); }, 0); });
        shell.addEventListener('change', function () { setTimeout(function () { updateTableStatus(state); }, 0); });
        table.addEventListener('click', function () { setTimeout(function () { reflectSort(state); }, 0); });
        tableStates.push(state);
        tableStateById[id] = state;
        updateTableStatus(state);
        applyTableSearch(state);
    }

    function buildColumnMenu(state, menu) {
        each(state.headers, function (th, index) {
            var label = make('label');
            var checkbox = make('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.addEventListener('change', function () {
                setColumnVisible(state, index, checkbox.checked);
            });
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(textOf(th) || ('Column ' + (index + 1))));
            menu.appendChild(label);
        });
    }

    function setColumnVisible(state, index, visible) {
        var rows = state.table.querySelectorAll('tr');
        each(rows, function (row) {
            var cell = row.cells && row.cells[index];
            if (cell) { cell.style.display = visible ? '' : 'none'; }
        });
        state.headers[index].setAttribute('aria-hidden', visible ? 'false' : 'true');
    }

    function sortDirection(th) {
        var child = th.querySelector('[class]');
        var classes = ((th.className || '') + ' ' + (child ? child.className || '' : '')).toLowerCase();
        if (/sort[^a-z]*(asc|up)|ascending/.test(classes)) { return 'ascending'; }
        if (/sort[^a-z]*(desc|down)|descending/.test(classes)) { return 'descending'; }
        return 'none';
    }

    function reflectSort(state) {
        if (state.sorts && state.sorts.length) { return; }
        each(state.headers, function (th) { th.setAttribute('aria-sort', sortDirection(th)); });
    }

    function tableSortValue(row, index) {
        var raw = cellValue(row, index).trim();
        var numeric;
        var timestamp;
        if (/^-?\d+(?:[.,]\d+)?%?$/.test(raw)) {
            numeric = Number(raw.replace('%', '').replace(',', '.'));
            if (!isNaN(numeric)) { return { rank: 0, value: numeric }; }
        }
        if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
            timestamp = Date.parse(raw);
            if (!isNaN(timestamp)) { return { rank: 1, value: timestamp }; }
        }
        return { rank: 2, value: raw.toLowerCase() };
    }

    function updateSortHeaders(state) {
        each(state.headers, function (th, index) {
            var sort = null;
            var priority = -1;
            each(state.sorts, function (candidate, sortIndex) {
                if (candidate.index === index) { sort = candidate; priority = sortIndex; }
            });
            th.setAttribute('aria-sort', sort ? sort.direction : 'none');
            if (sort) {
                th.setAttribute('data-sort-priority', String(priority + 1));
                th.title = 'Sorted ' + sort.direction + ' (priority ' + (priority + 1) + '). Shift-click to add another column.';
            } else {
                th.removeAttribute('data-sort-priority');
                th.title = 'Sort ascending. Shift-click to add this column to the current sort.';
            }
        });
    }

    function applyTableSort(state) {
        var tbody = state.table.tBodies && state.table.tBodies[0];
        var ordered;
        if (!tbody) { return; }
        ordered = state.rows.slice();
        ordered.sort(function (a, b) {
            var result = 0;
            each(state.sorts, function (sort) {
                var av;
                var bv;
                if (result) { return; }
                av = tableSortValue(a, sort.index);
                bv = tableSortValue(b, sort.index);
                if (av.rank !== bv.rank) { result = av.rank < bv.rank ? -1 : 1; }
                else if (av.value < bv.value) { result = -1; }
                else if (av.value > bv.value) { result = 1; }
                if (sort.direction === 'descending') { result *= -1; }
            });
            return result || a._azadspiOriginalIndex - b._azadspiOriginalIndex;
        });
        each(ordered, function (row) { tbody.appendChild(row); });
        updateSortHeaders(state);
    }

    function toggleTableSort(state, index, additive) {
        var existing = -1;
        each(state.sorts, function (sort, sortIndex) { if (sort.index === index) { existing = sortIndex; } });
        if (!additive) {
            if (existing === -1) { state.sorts = []; }
            else { state.sorts = [state.sorts[existing]]; existing = 0; }
        }
        if (existing === -1) { state.sorts.push({ index: index, direction: 'ascending' }); }
        else if (state.sorts[existing].direction === 'ascending') { state.sorts[existing].direction = 'descending'; }
        else { state.sorts.splice(existing, 1); }
        applyTableSort(state);
    }

    function resetTableSort(state) {
        var tbody = state.table.tBodies && state.table.tBodies[0];
        state.sorts = [];
        if (tbody) {
            state.rows.slice().sort(function (a, b) { return a._azadspiOriginalIndex - b._azadspiOriginalIndex; }).forEach(function (row) {
                tbody.appendChild(row);
            });
        }
        updateSortHeaders(state);
    }

    function initTableSorting(state) {
        each(state.headers, function (th) { th.tabIndex = 0; });
        updateSortHeaders(state);
        state.table.addEventListener('click', function (event) {
            var target = event.target;
            var th = target && target.closest ? target.closest('th') : null;
            var index;
            if (!th || state.headers.indexOf(th) === -1) { return; }
            if (target.closest && target.closest('input, select, button, a, .azadspiResizeHandle')) { return; }
            index = state.headers.indexOf(th);
            event.preventDefault();
            event.stopPropagation();
            toggleTableSort(state, index, !!event.shiftKey);
        }, true);
        each(state.headers, function (th, index) {
            th.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.key === ' ' || event.keyCode === 13 || event.keyCode === 32) {
                    if (event.target !== th) { return; }
                    event.preventDefault();
                    toggleTableSort(state, index, !!event.shiftKey);
                }
            });
        });
    }

    function initColumnResizing(state) {
        var tableMinimumWidth = 0;
        each(state.headers, function (th) {
            var labelText = normalized(textOf(th));
            var recommendedWidth = /object id|application id|app id|client id|owner org/.test(labelText) ? 190
                : (/display name|principal name|^name$/.test(labelText) ? 180
                    : (/permission|notes|credential|resource|suggested action/.test(labelText) ? 220
                        : (/enabled|type|count|classification|audience/.test(labelText) ? 105 : 135)));
            var handle = make('span', 'azadspiResizeHandle');
            tableMinimumWidth += recommendedWidth;
            th.style.minWidth = recommendedWidth + 'px';
            handle.setAttribute('aria-hidden', 'true');
            handle.title = 'Drag to resize column; double-click to reset';
            handle.addEventListener('pointerdown', function (event) {
                var startX = event.clientX;
                var startWidth = th.getBoundingClientRect().width;
                function move(moveEvent) {
                    var width = Math.max(72, startWidth + moveEvent.clientX - startX);
                    th.style.width = width + 'px';
                    th.style.minWidth = width + 'px';
                }
                function stop() {
                    document.removeEventListener('pointermove', move);
                    document.removeEventListener('pointerup', stop);
                    document.body.classList.remove('azadspiResizing');
                }
                event.preventDefault();
                event.stopPropagation();
                document.body.classList.add('azadspiResizing');
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', stop);
            });
            handle.addEventListener('dblclick', function (event) {
                event.preventDefault();
                event.stopPropagation();
                th.style.width = '';
                th.style.minWidth = '';
            });
            th.appendChild(handle);
        });
        state.table.style.minWidth = tableMinimumWidth + 'px';
    }

    function nativeFilterCount(state) {
        var count = 0;
        each(state.table.querySelectorAll('thead input, thead select'), function (control) {
            if (control.type === 'button' || control.type === 'reset') { return; }
            if (String(control.value || '').trim()) { count++; }
        });
        return count;
    }

    function rowIsRendered(row) {
        return !row.hidden && (!window.getComputedStyle || window.getComputedStyle(row).display !== 'none');
    }

    function updateTableStatus(state) {
        var visible = 0;
        var filters = nativeFilterCount(state) + (state.localQuery ? 1 : 0) + (globalQuery ? 1 : 0);
        each(state.rows, function (row) { if (rowIsRendered(row)) { visible++; } });
        state.status.textContent = visible + ' of ' + state.rows.length + ' rows' + (filters ? ' \u00b7 ' + filters + ' active filter' + (filters === 1 ? '' : 's') : '');
    }

    function applyTableSearch(state) {
        var tabStop = null;
        each(state.rows, function (row) {
            var hay = row.getAttribute('data-azadspi-search-text') || rowText(row);
            var globalMatch = !globalQuery || (mapSelectionTokens.length
                ? mapSelectionTokens.some(function (token) { return hay.indexOf(token) !== -1; })
                : hay.indexOf(globalQuery) !== -1);
            row.hidden = !!(!globalMatch || (state.localQuery && hay.indexOf(state.localQuery) === -1));
            if (!row.hidden && !tabStop) { tabStop = row; }
        });
        if (state.selectedRow && !state.selectedRow.hidden) { tabStop = state.selectedRow; }
        each(state.rows, function (row) { row.tabIndex = row === tabStop ? 0 : -1; });
        updateTableStatus(state);
    }

    function applyAllTableSearch() {
        each(tableStates, applyTableSearch);
        updateActiveFilters();
        renderFindings();
    }

    function nativeTableFilter(state) {
        var registry = window.azadspiTableFilters || {};
        return registry[state.id] || window['tf' + state.id] || null;
    }

    function resetNativeFilters(state) {
        var instance = nativeTableFilter(state);
        if (instance && typeof instance.clearFilters === 'function') {
            try {
                instance.clearFilters();
                if (typeof instance.filter === 'function') { instance.filter(); }
                return;
            } catch (e) { /* fall back to controls */ }
        }
        each(state.table.querySelectorAll('thead input, thead select'), function (control) {
            if (control.type === 'button' || control.type === 'reset') { return; }
            control.value = '';
            try { control.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* old browser */ }
        });
    }

    function resetTable(state, search) {
        state.localQuery = '';
        search.value = '';
        resetTableSort(state);
        resetNativeFilters(state);
        applyTableSearch(state);
        persistUrlState(state);
    }

    function csvCell(value) {
        return '"' + String(value || '').replace(/"/g, '""') + '"';
    }

    function exportVisibleRows(state, delimiter) {
        var visibleColumns = [];
        var lines = [];
        var csv;
        var blob;
        var url;
        var link;
        each(state.headers, function (th, index) {
            if (th.style.display !== 'none') { visibleColumns.push(index); }
        });
        delimiter = delimiter || ',';
        lines.push(visibleColumns.map(function (index) { return csvCell(textOf(state.headers[index])); }).join(delimiter));
        each(state.rows, function (row) {
            if (!rowIsRendered(row)) { return; }
            lines.push(visibleColumns.map(function (index) { return csvCell(cellValue(row, index)); }).join(delimiter));
        });
        csv = '\ufeff' + lines.join('\r\n');
        blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        url = URL.createObjectURL(blob);
        link = make('a');
        link.href = url;
        link.download = state.id + '-filtered.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function copyText(value) {
        var textarea;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).catch(function () { /* clipboard permission denied */ });
            return;
        }
        textarea = make('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand('copy'); } catch (e) { /* clipboard unavailable */ }
        document.body.removeChild(textarea);
    }

    function copyRow(state, row) {
        var values = [];
        each(state.headers, function (th, index) {
            if (th.style.display === 'none') { return; }
            values.push(textOf(th) + ': ' + cellValue(row, index));
        });
        copyText(values.join('\n'));
        if (state.status) { state.status.textContent = 'Selected row copied'; }
    }

    function selectRow(row, openDetails) {
        each(document.querySelectorAll('.azadspiSelectedRow'), function (selected) {
            selected.classList.remove('azadspiSelectedRow');
            selected.setAttribute('aria-selected', 'false');
        });
        row.classList.add('azadspiSelectedRow');
        row.setAttribute('aria-selected', 'true');
        each(row._azadspiState.rows, function (candidate) { candidate.tabIndex = candidate === row ? 0 : -1; });
        row._azadspiState.selectedRow = row;
        activeTableState = row._azadspiState;
        persistUrlState(activeTableState);
        if (openDetails) { showDrawer(row._azadspiState, row); }
    }

    function initDrawer() {
        var header;
        var title;
        var close;
        var body;
        drawer = make('aside', 'azadspiDrawer');
        drawer.id = 'azadspiDetailDrawer';
        drawer.setAttribute('role', 'dialog');
        drawer.setAttribute('aria-modal', 'false');
        drawer.setAttribute('aria-labelledby', 'azadspiDrawerTitle');
        drawer.setAttribute('aria-hidden', 'true');
        drawer.setAttribute('inert', '');
        drawer.hidden = true;
        header = make('header', 'azadspiDrawerHeader');
        title = make('h2', 'azadspiDrawerTitle', 'Details');
        title.id = 'azadspiDrawerTitle';
        close = make('button', 'azadspiDrawerClose', '\u00d7');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close details');
        close.addEventListener('click', closeDrawer);
        body = make('div', 'azadspiDrawerBody');
        header.appendChild(title);
        header.appendChild(close);
        drawer.appendChild(header);
        drawer.appendChild(body);
        drawer._title = title;
        drawer._body = body;
        document.body.appendChild(drawer);
        document.addEventListener('keydown', function (event) {
            if ((event.key === 'Escape' || event.keyCode === 27) && drawer.classList.contains('is-open')) { closeDrawer(); }
        });
    }

    function closeDrawer() {
        if (!drawer) { return; }
        drawer.classList.remove('is-open');
        drawer.setAttribute('aria-hidden', 'true');
        drawer.setAttribute('inert', '');
        drawer.hidden = true;
        document.body.classList.remove('azadspiDrawerOpen');
        if (drawer._returnFocus && drawer._returnFocus.focus) {
            try { drawer._returnFocus.focus({ preventScroll: true }); } catch (e) { drawer._returnFocus.focus(); }
        }
    }

    function identityLabel(state, row) {
        var index = headerIndex(state, /display\s*name|^name$|^user$/);
        return cellValue(row, index) || state.title;
    }

    function showDrawer(state, row) {
        var dl = make('dl', 'azadspiDrawerFields');
        var actions = make('div', 'azadspiDrawerActions');
        var mapButton;
        var sourceButton;
        drawer._title.textContent = identityLabel(state, row);
        each(state.headers, function (th, index) {
            var value = cellValue(row, index);
            if (!value) { return; }
            dl.appendChild(make('dt', '', textOf(th)));
            dl.appendChild(make('dd', '', value));
        });
        if (row._azadspiNode) {
            mapButton = make('button', 'azadspiActionBtn', 'Show in map');
            mapButton.type = 'button';
            mapButton.addEventListener('click', function () { focusMapNode(row._azadspiNode); });
            actions.appendChild(mapButton);
        }
        sourceButton = make('button', 'azadspiActionBtn', 'Show source row');
        sourceButton.type = 'button';
        sourceButton.addEventListener('click', function () {
            closeDrawer();
            revealRow(row);
        });
        actions.appendChild(sourceButton);
        var copyButton = make('button', 'azadspiActionBtn', 'Copy row');
        copyButton.type = 'button';
        copyButton.addEventListener('click', function () { copyRow(state, row); });
        actions.appendChild(copyButton);
        drawer._body.textContent = '';
        drawer._body.appendChild(dl);
        drawer._body.appendChild(actions);
        drawer.hidden = false;
        drawer.removeAttribute('inert');
        drawer.classList.add('is-open');
        drawer.setAttribute('aria-hidden', 'false');
        document.body.classList.add('azadspiDrawerOpen');
        drawer._returnFocus = document.activeElement;
        var closeControl = drawer.querySelector('.azadspiDrawerClose');
        if (closeControl) { closeControl.focus(); }
    }

    function focusMapNode(node) {
        if (!node) { return; }
        emit('azadspi:focus-node', {
            id: node.id,
            nodeId: node.id,
            objectId: node.m && node.m.objectId,
            appId: node.m && node.m.appId,
            node: node,
            source: 'table'
        });
        var section = document.getElementById('identityMap');
        if (section && section.scrollIntoView) { section.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }

    function revealWithNativeTableFilter(state, row) {
        var instance = nativeTableFilter(state);
        var objectId = row.getAttribute('data-object-id') || '';
        var appId = row.getAttribute('data-app-id') || (row._azadspiNode && row._azadspiNode.m && row._azadspiNode.m.appId) || '';
        var token = objectId || appId;
        var column = -1;
        if (!instance || typeof instance.setFilterValue !== 'function' || typeof instance.filter !== 'function' || !token) { return false; }
        each(row.cells, function (cell, index) {
            if (column === -1 && textOf(cell).toLowerCase().indexOf(String(token).toLowerCase()) !== -1) { column = index; }
        });
        if (column === -1) { return false; }
        try {
            if (typeof instance.clearFilters === 'function') { instance.clearFilters(); }
            instance.setFilterValue(column, token);
            instance.filter();
            updateTableStatus(state);
            return true;
        } catch (e) { return false; }
    }

    function revealRow(row) {
        var content = row.closest ? row.closest('.content') : null;
        var button;
        var state = row._azadspiState;
        var nativeFilterApplied = false;
        if (content) {
            button = content.previousElementSibling;
            if (button && button.classList.contains('collapsible')) {
                button.classList.add('active');
                button.setAttribute('aria-expanded', 'true');
            }
        }
        selectRow(row, false);
        row.hidden = false;
        if (state && !rowIsRendered(row)) { nativeFilterApplied = revealWithNativeTableFilter(state, row); }
        function finishReveal() {
            row.hidden = false;
            if (row.scrollIntoView) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            try { row.focus({ preventScroll: true }); } catch (e) { row.focus(); }
        }
        if (nativeFilterApplied) { setTimeout(finishReveal, 80); }
        else { finishReveal(); }
    }

    function addFinding(finding) {
        var nodePart = finding.node ? finding.node.id : finding.identity;
        var key = normalized(finding.category) + '|' + normalized(nodePart);
        if (finding.preset === 'expiring-credentials') { key += '|' + normalized(finding.evidence); }
        if (findingKeys[key]) { return; }
        findingKeys[key] = true;
        findings.push(finding);
    }

    function buildFindings() {
        buildMapFindings();
        buildTableFindings();
        findings.sort(function (a, b) {
            var rank = { Critical: 0, High: 1, Medium: 2, Info: 3 };
            return rank[a.severity] - rank[b.severity] || a.identity.localeCompare(b.identity);
        });
    }

    function buildMapFindings() {
        var criticalBySource = {};
        var i;
        var edge;
        var source;
        var target;
        var meta;
        var change;
        each(mapData.edges, function (item) {
            source = mapNodesById[item.s];
            target = mapNodesById[item.d];
            if (!source || !target || (item.k !== 'permApp' && item.k !== 'permDel') || (item.r !== 'critical' && target.r !== 'critical')) { return; }
            if (!criticalBySource[source.id]) { criticalBySource[source.id] = { node: source, app: [], delegated: [] }; }
            (item.k === 'permApp' ? criticalBySource[source.id].app : criticalBySource[source.id].delegated).push(target.l || item.l || target.id);
        });
        Object.keys(criticalBySource).forEach(function (key) {
            var item = criticalBySource[key];
            var evidence = [];
            if (item.app.length) { evidence.push('Application: ' + item.app.slice(0, 6).join(', ') + (item.app.length > 6 ? ' (+' + (item.app.length - 6) + ')' : '')); }
            if (item.delegated.length) { evidence.push('Delegated: ' + item.delegated.slice(0, 6).join(', ') + (item.delegated.length > 6 ? ' (+' + (item.delegated.length - 6) + ')' : '')); }
            addFinding({ category: 'Critical permissions', preset: 'critical-permissions', severity: 'Critical', identity: item.node.l || item.node.id, evidence: evidence.join(' \u00b7 '), recommendation: 'Validate admin consent and least privilege.', node: item.node, row: sourceRowForNode(item.node) });
        });
        for (i = 0; i < mapData.nodes.length; i++) {
            source = mapData.nodes[i];
            meta = source.m || {};
            if ((source.t === 'app' || source.t === 'agent') && !Number(meta.spOwnerCount || 0) && !Number(meta.appOwnerCount || 0)) {
                addFinding({ category: 'Ownerless identities', preset: 'ownerless', severity: 'High', identity: source.l || source.id, evidence: 'No service-principal or application owner is recorded.', recommendation: 'Assign an accountable owner and confirm lifecycle.', node: source, row: sourceRowForNode(source) });
            }
            if (meta.stale) {
                addFinding({ category: 'Stale identities', preset: 'stale', severity: 'Medium', identity: source.l || source.id, evidence: (meta.staleReasons && meta.staleReasons.length ? meta.staleReasons.join('; ') : 'Marked stale by the report collector.') + (meta.lastSignIn ? ' Last sign-in: ' + meta.lastSignIn + '.' : ''), recommendation: 'Confirm with the owner, then disable before deletion.', node: source, row: sourceRowForNode(source) });
            }
            if (source.t === 'agent' && meta.noSponsor === true) {
                addFinding({ category: 'Sponsorless agents', preset: 'sponsorless-agents', severity: 'High', identity: source.l || source.id, evidence: 'Agent identity has no accountable sponsor.', recommendation: 'Assign a human or group sponsor.', node: source, row: sourceRowForNode(source) });
            }
            if (meta.accountEnabled === false && Number(meta.assignedToCount || 0) > 0) {
                addFinding({ category: 'Disabled but assigned', preset: 'disabled-assigned', severity: 'High', identity: source.l || source.id, evidence: 'Identity is disabled but still has ' + meta.assignedToCount + ' assignment' + (Number(meta.assignedToCount) === 1 ? '' : 's') + '.', recommendation: 'Remove obsolete assignments or document the exception.', node: source, row: sourceRowForNode(source) });
            }
            change = meta.changeType || meta.change;
            if (change && normalized(change) !== 'unchanged' && normalized(change) !== 'none') {
                addFinding({ category: 'Changes', preset: 'changes', severity: /removed|changed|modified/i.test(String(change)) ? 'Medium' : 'Info', identity: source.l || source.id, evidence: 'Snapshot change: ' + String(change) + '.', recommendation: 'Review the changed identity and its relationships.', node: source, row: sourceRowForNode(source) });
            }
        }
        var stats = mapData.stats || {};
        var added = Number(stats.addedNodeCount || 0);
        var changed = Number(stats.changedNodeCount || 0);
        var removed = Number(stats.removedNodeCount || 0);
        if ((added || changed || removed) && !findings.some(function (f) { return f.preset === 'changes'; })) {
            addFinding({ category: 'Changes', preset: 'changes', severity: changed || removed ? 'Medium' : 'Info', identity: 'Tenant snapshot', evidence: added + ' added, ' + changed + ' changed, ' + removed + ' removed.', recommendation: 'Review snapshot changes before accepting the new baseline.' });
        }
    }

    function buildTableFindings() {
        each(tableStates, function (state) {
            var classificationIndex = headerIndex(state, /classification|sensitivity/);
            var permissionIndex = headerIndex(state, /permission|role\s*assignment|oauth.*grant/);
            var typeIndex = headerIndex(state, /^type$|sp\s*type|object\s*type/);
            var spOwnersIndex = headerIndex(state, /sp\s*owners|service\s*principal\s*owners/);
            var appOwnersIndex = headerIndex(state, /app\s*owners|application\s*owners/);
            var credentialsIndex = headerIndex(state, /application\s*(secret|certificate)|credential/);
            var sponsorIndex = headerIndex(state, /sponsor/);
            var enabledIndex = headerIndex(state, /^enabled$|account\s*enabled/);
            var assignedIndex = headerIndex(state, /assigned\s*(to|principal)|assignment.*count|count.*assignment/);
            var staleTable = /stale/.test(normalized(state.title + ' ' + state.id));
            each(state.rows, function (row) {
                var node = row._azadspiNode;
                var identity = identityLabel(state, row);
                var evidence;
                var credential;
                var expiry;
                var upperDays;
                var type = cellValue(row, typeIndex).toLowerCase();
                if (classificationIndex >= 0 && /critical/i.test(cellValue(row, classificationIndex))) {
                    evidence = permissionIndex >= 0 ? shortText(cellValue(row, permissionIndex), 300) : 'Table classification is critical.';
                    addFinding({ category: 'Critical permissions', preset: 'critical-permissions', severity: 'Critical', identity: identity, evidence: evidence, recommendation: 'Validate admin consent and least privilege.', node: node, row: row });
                }
                if (/serviceprincipals$|service principals$/i.test(state.title) && type && type.indexOf('ext') === -1 && spOwnersIndex >= 0 && !cellValue(row, spOwnersIndex) && (appOwnersIndex < 0 || !cellValue(row, appOwnersIndex))) {
                    addFinding({ category: 'Ownerless identities', preset: 'ownerless', severity: 'High', identity: identity, evidence: 'Owner columns are empty in the service-principal inventory.', recommendation: 'Assign an accountable owner and confirm lifecycle.', node: node, row: row });
                }
                if (credentialsIndex >= 0) {
                    credential = cellValue(row, credentialsIndex);
                    expiry = /expires?\s+in\s+(\d+)(?:\s+to\s+(\d+))?\s+days?/i.exec(credential);
                    upperDays = expiry ? Number(expiry[2] || expiry[1]) : null;
                    if (/\bexpired\b/i.test(credential) || (upperDays !== null && upperDays <= 90)) {
                        addFinding({ category: 'Expiring credentials', preset: 'expiring-credentials', severity: /\bexpired\b/i.test(credential) ? 'Critical' : 'High', identity: identity, evidence: shortText(credential, 300), recommendation: /\bexpired\b/i.test(credential) ? 'Remove or replace the expired credential.' : 'Rotate the credential before expiry.', node: node, row: row });
                    }
                }
                if (staleTable) {
                    addFinding({ category: 'Stale identities', preset: 'stale', severity: 'Medium', identity: identity, evidence: shortText(cellValue(row, headerIndex(state, /reason|last\s*sign/)) || 'Listed in the stale identities inventory.', 300), recommendation: 'Confirm with the owner, then disable before deletion.', node: node, row: row });
                }
                if (sponsorIndex >= 0 && /agent/.test(type) && /^(none|-)?$/i.test(cellValue(row, sponsorIndex))) {
                    addFinding({ category: 'Sponsorless agents', preset: 'sponsorless-agents', severity: 'High', identity: identity, evidence: 'Sponsor field is empty or none.', recommendation: 'Assign a human or group sponsor.', node: node, row: row });
                }
                if (enabledIndex >= 0 && /^(false|disabled|no)$/i.test(cellValue(row, enabledIndex)) && assignedIndex >= 0 && Number((cellValue(row, assignedIndex).match(/\d+/) || [0])[0]) > 0) {
                    addFinding({ category: 'Disabled but assigned', preset: 'disabled-assigned', severity: 'High', identity: identity, evidence: 'Disabled identity still has assignments recorded in the source table.', recommendation: 'Remove obsolete assignments or document the exception.', node: node, row: row });
                }
            });
        });
    }

    function createWorkspace() {
        var workspace = make('section', 'azadspiWorkspace');
        var header = make('header', 'azadspiWorkspaceHeader');
        var intro = make('div');
        var title = make('h2', '', 'Investigation workspace');
        var subtitle = make('p', '', 'Prioritized evidence from the map and report inventories.');
        var searchWrap = make('div', 'azadspiWorkspaceSearch');
        var search = make('input');
        var active = make('div', 'azadspiActiveFilters');
        var reset = make('button', 'azadspiToolbarBtn', 'Clear filters');
        var presetBar = make('div', 'azadspiPresetBar');
        var summary = make('div', 'azadspiFindingSummary');
        var findingsViewport = make('div', 'azadspiFindingsViewport');
        var findingsTable = make('table', 'summaryTable azadspiFindingsTable');
        var thead = make('thead');
        var headingRow = make('tr');
        var tbody = make('tbody');
        var presets = [
            ['all', 'All findings'],
            ['critical-permissions', 'Critical permissions'],
            ['ownerless', 'Ownerless'],
            ['expiring-credentials', 'Expiring credentials'],
            ['stale', 'Stale identities'],
            ['sponsorless-agents', 'Sponsorless agents'],
            ['disabled-assigned', 'Disabled but assigned'],
            ['changes', 'Changes']
        ];
        workspace.id = 'azadspiInvestigation';
        intro.appendChild(title);
        intro.appendChild(subtitle);
        search.type = 'search';
        search.id = 'azadspiGlobalSearch';
        search.placeholder = 'Search all findings and tables';
        search.setAttribute('aria-label', 'Search all findings and report tables');
        search.value = globalQuery;
        search.addEventListener('input', function () {
            globalQuery = search.value.toLowerCase().trim();
            mapSelectionLabel = '';
            mapSelectionTokens = [];
            queryBeforeMapSelection = '';
            applyAllTableSearch();
            persistUrlState();
        });
        active.id = 'azadspiActiveFilters';
        active.setAttribute('aria-live', 'polite');
        searchWrap.appendChild(search);
        searchWrap.appendChild(active);
        reset.id = 'azadspiGlobalReset';
        reset.type = 'button';
        reset.addEventListener('click', function () {
            globalQuery = '';
            mapSelectionLabel = '';
            mapSelectionTokens = [];
            queryBeforeMapSelection = '';
            search.value = '';
            activePreset = 'all';
            activeTableState = null;
            each(tableStates, function (state) {
                state.localQuery = '';
                if (state.search) { state.search.value = ''; }
                resetNativeFilters(state);
                applyTableSearch(state);
            });
            updatePresetButtons();
            updateActiveFilters();
            renderFindings();
            persistUrlState();
        });
        header.appendChild(intro);
        header.appendChild(searchWrap);
        header.appendChild(reset);
        workspace.appendChild(header);
        each(presets, function (preset) {
            var count = preset[0] === 'all' ? findings.length : findings.filter(function (f) { return f.preset === preset[0]; }).length;
            var button = make('button', 'azadspiPreset preset-' + preset[0], preset[1] + ' (' + count + ')');
            button.type = 'button';
            button.setAttribute('data-preset', preset[0]);
            button.setAttribute('aria-pressed', preset[0] === activePreset ? 'true' : 'false');
            if (preset[0] === activePreset) { button.classList.add('is-active'); }
            button.addEventListener('click', function () {
                activePreset = preset[0];
                updatePresetButtons();
                updateActiveFilters();
                renderFindings();
                persistUrlState();
            });
            presetBar.appendChild(button);
        });
        workspace.appendChild(presetBar);
        workspace.appendChild(summary);
        ['Severity', 'Finding', 'Identity', 'Evidence', 'Suggested action', 'Investigate'].forEach(function (label) {
            var th = make('th', '', label);
            th.setAttribute('scope', 'col');
            headingRow.appendChild(th);
        });
        thead.appendChild(headingRow);
        findingsTable.id = 'azadspiFindingsTable';
        var caption = make('caption', 'azadspiTableCaption', 'Actionable identity findings');
        findingsTable.appendChild(caption);
        findingsTable.appendChild(thead);
        findingsTable.appendChild(tbody);
        findingsViewport.appendChild(findingsTable);
        workspace.appendChild(findingsViewport);
        workspaceElements = { workspace: workspace, search: search, active: active, summary: summary, tbody: tbody, table: findingsTable };
        var insertBefore = document.getElementById('identityMap') || document.querySelector('button.collapsible, button.nonCollapsible');
        if (insertBefore && insertBefore.parentNode) { insertBefore.parentNode.insertBefore(workspace, insertBefore); }
        else {
            var summaryContainer = document.getElementById('summary') || document.body;
            summaryContainer.insertBefore(workspace, summaryContainer.firstChild);
        }
        updateActiveFilters();
        renderFindings();
    }

    function updatePresetButtons() {
        each(document.querySelectorAll('.azadspiPreset[data-preset]'), function (button) {
            var active = button.getAttribute('data-preset') === activePreset;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function updateActiveFilters() {
        if (!workspaceElements.active) { return; }
        var labels = [];
        if (activePreset !== 'all') { labels.push('Lens: ' + activePreset.replace(/-/g, ' ')); }
        if (globalQuery) { labels.push((mapSelectionLabel ? 'Map selection: ' + mapSelectionLabel : 'Search: ' + globalQuery)); }
        workspaceElements.active.textContent = labels.length ? labels.join(' \u00b7 ') : 'No investigation filters active';
    }

    function findingMatches(finding) {
        var hay;
        if (activePreset !== 'all' && finding.preset !== activePreset) { return false; }
        if (!globalQuery) { return true; }
        hay = [finding.severity, finding.category, finding.identity, finding.evidence, finding.recommendation].join(' ').toLowerCase();
        if (mapSelectionTokens.length) {
            return mapSelectionTokens.some(function (token) {
                return hay.indexOf(token) !== -1 || (finding.row && rowText(finding.row).indexOf(token) !== -1);
            });
        }
        return hay.indexOf(globalQuery) !== -1 || (finding.row && rowText(finding.row).indexOf(globalQuery) !== -1);
    }

    function renderFindings() {
        if (!workspaceElements.tbody) { return; }
        var visible = findings.filter(findingMatches);
        var counts = { Critical: 0, High: 0, Medium: 0, Info: 0 };
        workspaceElements.tbody.textContent = '';
        workspaceElements.summary.textContent = '';
        each(visible, function (finding) { counts[finding.severity] = (counts[finding.severity] || 0) + 1; });
        ['Critical', 'High', 'Medium', 'Info'].forEach(function (severity) {
            if (!counts[severity]) { return; }
            var chip = make('span', 'azadspiFindingCount severity-' + severity.toLowerCase(), counts[severity] + ' ' + severity.toLowerCase());
            workspaceElements.summary.appendChild(chip);
        });
        if (!visible.length) {
            var emptyRow = make('tr');
            var emptyCell = make('td', 'azadspiEmptyState', 'No findings match this lens and search.');
            emptyCell.colSpan = 6;
            emptyRow.appendChild(emptyCell);
            workspaceElements.tbody.appendChild(emptyRow);
            return;
        }
        each(visible, function (finding) {
            var row = make('tr');
            var severityCell = make('td');
            var severity = make('span', 'azadspiSeverity severity-' + finding.severity.toLowerCase(), finding.severity);
            var actions = make('td', 'azadspiFindingActions');
            var mapButton;
            var sourceButton;
            severityCell.appendChild(severity);
            row.appendChild(severityCell);
            row.appendChild(make('td', '', finding.category));
            row.appendChild(make('td', '', finding.identity));
            row.appendChild(make('td', '', finding.evidence));
            row.appendChild(make('td', '', finding.recommendation));
            if (finding.node) {
                mapButton = make('button', 'azadspiActionBtn', 'Show in map');
                mapButton.type = 'button';
                mapButton.addEventListener('click', function () { focusMapNode(finding.node); });
                actions.appendChild(mapButton);
            }
            if (finding.row) {
                sourceButton = make('button', 'azadspiActionBtn', 'Show source');
                sourceButton.type = 'button';
                sourceButton.addEventListener('click', function () { revealRow(finding.row); });
                actions.appendChild(sourceButton);
            }
            row.appendChild(actions);
            workspaceElements.tbody.appendChild(row);
        });
    }

    function mapDetailTokens(detail) {
        var tokens = [];
        function add(value) {
            var token = String(value || '').toLowerCase().trim();
            if (token && tokens.indexOf(token) === -1) { tokens.push(token); }
        }
        function addNode(nodeDetail) {
            if (!nodeDetail) { return; }
            var node = nodeDetail.node || mapNodesById[nodeDetail.nodeId || nodeDetail.id];
            add(nodeDetail.objectId);
            add(nodeDetail.appId);
            add(nodeDetail.id);
            add(nodeDetail.label);
            if (node) {
                add(node.id);
                add(node.l);
                add(node.m && node.m.objectId);
                add(node.m && node.m.appId);
            }
        }
        addNode(detail);
        each(detail.objectIds, add);
        each(detail.appIds, add);
        each(detail.ids, add);
        each(detail.nodes, addNode);
        return tokens;
    }

    function onMapSelect(event) {
        var detail = event.detail || {};
        var node = detail.node || mapNodesById[detail.nodeId || detail.id];
        var tokens = mapDetailTokens(detail);
        var token = tokens[0] || '';
        var matches = [];
        if (!token) {
            if (detail.source === 'permission-map' && mapSelectionTokens.length) {
                globalQuery = queryBeforeMapSelection;
                queryBeforeMapSelection = '';
                mapSelectionLabel = '';
                mapSelectionTokens = [];
                if (workspaceElements.search) { workspaceElements.search.value = globalQuery; }
                each(document.querySelectorAll('.azadspiMapMatch'), function (row) { row.classList.remove('azadspiMapMatch'); });
                applyAllTableSearch();
                persistUrlState();
            }
            return [];
        }
        if (!mapSelectionTokens.length) { queryBeforeMapSelection = globalQuery; }
        mapSelectionTokens = tokens;
        globalQuery = token;
        mapSelectionLabel = detail.nodes && detail.nodes.length
            ? detail.nodes.length + ' map nodes'
            : (node && node.l) || detail.label || String(token);
        if (workspaceElements.search) { workspaceElements.search.value = mapSelectionLabel; }
        each(document.querySelectorAll('.azadspiMapMatch'), function (row) { row.classList.remove('azadspiMapMatch'); });
        each(tableStates, function (state) {
            each(state.rows, function (row) {
                var hay = rowText(row);
                if (tokens.some(function (candidate) { return hay.indexOf(candidate) !== -1; })) {
                    row.classList.add('azadspiMapMatch');
                    matches.push(row);
                }
            });
            applyTableSearch(state);
        });
        updateActiveFilters();
        renderFindings();
        persistUrlState();
        return matches;
    }

    function onShowRelated(event) {
        var matches = onMapSelect(event) || [];
        if (matches.length) { revealRow(matches[0]); }
    }

    function onShowFindings(event) {
        activePreset = 'all';
        updatePresetButtons();
        onMapSelect(event);
        if (workspaceElements.workspace) {
            workspaceElements.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function initInvestigationWorkspace() {
        restoredUrlState = readUrlState();
        activePreset = restoredUrlState.azlens || 'all';
        globalQuery = String(restoredUrlState.azq || '').toLowerCase().trim();
        loadMapData();
        enhanceTables();
        initDrawer();
        buildFindings();
        createWorkspace();
        applyAllTableSearch();
        document.addEventListener('azadspi:map-select', onMapSelect);
        document.addEventListener('azadspi:show-related', onShowRelated);
        document.addEventListener('azadspi:show-findings', onShowFindings);
    }

    function init() {
        initThemeToggle();
        initCollapsibles();
        initInvestigationWorkspace();
        modernizeCharts();
        rethemeCharts();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    window.addEventListener('load', hideLoader);
    /* safety net: never leave the loader up */
    setTimeout(hideLoader, 6000);
})();
