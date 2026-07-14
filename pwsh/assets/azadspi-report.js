/* AzADServicePrincipalInsights - report behaviors (self-contained, replaces azadvertizer toggle/collapsetable scripts) */
(function () {
    'use strict';

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

    function rethemeCharts() {
        if (typeof Chart === 'undefined') { return; }
        var styles = getComputedStyle(document.documentElement);
        var ink = styles.getPropertyValue('--ink-2').trim() || '#52514e';
        var font = styles.getPropertyValue('--font').trim() || 'system-ui, sans-serif';
        if (Chart.defaults && Chart.defaults.global) {
            Chart.defaults.global.defaultFontColor = ink;
            Chart.defaults.global.defaultFontFamily = font;
        }
        if (Chart.instances) {
            Object.keys(Chart.instances).forEach(function (key) {
                try { Chart.instances[key].update(); } catch (e) { /* chart may be detached */ }
            });
        }
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
        document.querySelectorAll('button.collapsible').forEach(function (btn) {
            btn.addEventListener('click', function () {
                btn.classList.toggle('active');
            });
        });
        document.querySelectorAll('button.decollapsible').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var target = btn.nextElementSibling;
                while (target && !target.classList.contains('showContent')) {
                    target = target.nextElementSibling;
                }
                if (target) { target.classList.toggle('azadspiHidden'); }
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

    function init() {
        initThemeToggle();
        initCollapsibles();
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
