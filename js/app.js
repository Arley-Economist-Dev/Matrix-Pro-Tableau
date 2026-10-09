/**
 * ============================================================================
 * MatrixApp — Main Application Controller
 * ============================================================================
 *
 * Orchestrates all components:
 *   1. TableauConnector — data extraction & cross-filtering
 *   2. PivotEngine      — data transformation
 *   3. MatrixRenderer    — DOM rendering
 *   4. ExportManager     — Excel/CSV export
 *
 * Lifecycle:
 *   DOM ready → init() → connect to Tableau → load config → fetch data →
 *   transform → render → listen for changes
 */

class MatrixApp {

  constructor() {
    this.connector = new TableauConnector();
    this.engine = null;
    this.renderer = null;
    this.exporter = new ExportManager();
    this.config = null;
    this._matrixData = null;
    this._isLoading = false;
    this._lastDataSignature = null;
    this._lastConfigStr = null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the application.
   */
  async init() {
    try {
      this._showLoading('Connecting to Tableau...');

      // 1. Initialize Tableau Extensions API
      await this.connector.initialize(() => this._openConfigDialog());

      // 2. Load saved configuration
      this.config = this.connector.loadConfig();

      // For Viz Extensions, always set worksheetName to the current sheet
      const wsNames = this.connector.getWorksheetNames();
      if (this.connector.isVizExtension && wsNames.length > 0) {
        if (!this.config) {
          this.config = { worksheetName: wsNames[0], rowFields: [], colFields: [], valueFields: [], theme: 'theme-light' };
        } else {
          this.config.worksheetName = wsNames[0];
        }
      }

      // Apply theme class and saved language
      const currentTheme = (this.config && this.config.theme) ? this.config.theme : 'theme-light';
      document.body.className = currentTheme;

      const currentLang = (this.config && this.config.language) ? this.config.language : (localStorage.getItem('matrixLang') || 'es');
      if (typeof applyI18n === 'function') applyI18n(currentLang);

      if (this.config && this.config.worksheetName) {
        // Always attempt to refresh: encodings come from Tableau Marks card shelves
        await this._refresh();

        // Register event listeners for data changes
        this.connector.registerDataChangeListener(
          this.config.worksheetName,
          () => this._onDataChanged()
        );
      } else {
        this._showWelcome();
      }

      // 3. Wire up toolbar buttons
      this._bindToolbar();

      // 4. Setup instant real-time config listener (BroadcastChannel & Storage)
      this._setupConfigSync();

    } catch (err) {
      console.error('[MatrixApp] Initialization error:', err);
      this._showError(err);
    }
  }

  _applyVisibilityClasses() {
    if (!this.config) return;
    const noTB = this.config.showToolbar === false || String(this.config.showToolbar) === 'false';
    const noSB = this.config.showStatusBar === false || String(this.config.showStatusBar) === 'false';
    const noEX = this.config.showExportButtons === false || String(this.config.showExportButtons) === 'false';

    document.body.classList.toggle('no-toolbar', noTB);
    document.body.classList.toggle('no-statusbar', noSB);
    document.body.classList.toggle('no-export', noEX);

    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.classList.toggle('no-toolbar', noTB);
      appEl.classList.toggle('no-statusbar', noSB);
      appEl.classList.toggle('no-export', noEX);
    }
  }

  /**
   * Listen for real-time format changes broadcast from config dialog window.
   * @private
   */
  _setupConfigSync() {
    const applyConfig = (newConfig) => {
      if (!newConfig) return;
      console.log('[MatrixApp] Real-time config update received:', newConfig);
      this.config = Object.assign({}, this.config, newConfig);
      const theme = this.config.theme || 'theme-light';
      document.body.className = theme;
      const appEl = document.getElementById('app');
      if (appEl) appEl.className = theme;
      const wrapEl = document.getElementById('matrix-wrapper');
      if (wrapEl) wrapEl.className = `matrix-wrapper ${theme}`;

      if (newConfig.language && typeof applyI18n === 'function') {
        applyI18n(newConfig.language);
      }

      this._applyVisibilityClasses();
      this._refresh();
    };

    try {
      if ('BroadcastChannel' in window) {
        const bc = new BroadcastChannel('matrix_config_channel');
        bc.onmessage = (event) => {
          if (event.data && event.data.type === 'APPLY_CONFIG' && event.data.config) {
            applyConfig(event.data.config);
          }
        };
      }
    } catch (e) {}

    window.addEventListener('storage', (e) => {
      if (e.key === 'matrixConfig' && e.newValue) {
        try {
          applyConfig(JSON.parse(e.newValue));
        } catch (err) {}
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Data Pipeline: Fetch → Transform → Render
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Full refresh: fetch data, transform, and render.
   * @private
   */
  async _refresh() {
    if (this._isLoading) return;
    this._isLoading = true;

    // Temporarily disable event listeners to avoid recursive rendering/fetching loops
    this.connector.removeAllListeners();

    const isInitialLoad = !this.renderer || !document.getElementById('matrix-container').innerHTML;

    try {
      // Apply configured theme
      const currentTheme = (this.config && this.config.theme) ? this.config.theme : 'theme-light';
      document.body.className = currentTheme;
      const appEl = document.getElementById('app');
      if (appEl) appEl.className = currentTheme;

      // Apply UI element visibility via CSS classes
      this._applyVisibilityClasses();

      if (isInitialLoad) this._showLoading(t('loading_shelves'));

      // 1. Read field assignments directly from Tableau Marks card shelves
      const encodings = await this.connector.getVisualSpecificationEncodings();

      let isEncodingsChanged = false;
      if (encodings) {
        // Compare with active configuration, and only save if fields changed
        const rowsChanged = JSON.stringify(this.config.rowFields) !== JSON.stringify(encodings.rowFields);
        const colsChanged = JSON.stringify(this.config.colFields) !== JSON.stringify(encodings.colFields);
        const valsChanged = JSON.stringify(this.config.valueFields) !== JSON.stringify(encodings.valueFields);
        isEncodingsChanged = rowsChanged || colsChanged || valsChanged;

        if (isEncodingsChanged) {
          this.config.rowFields = encodings.rowFields || [];
          this.config.colFields = encodings.colFields || [];
          this.config.valueFields = encodings.valueFields || [];
          this.connector.saveConfig(this.config);
        }
      }

      // Check if required fields exist (must have at least Rows)
      const hasRows = this.config.rowFields && this.config.rowFields.length > 0;

      if (!hasRows) {
        const msg = t('config_prompt_default');
        this._showConfigPrompt(msg);
        this._isLoading = false;
        this._lastDataSignature = null;
        this._lastConfigStr = null;
        return;
      }

      if (isInitialLoad) this._showLoading(t('loading_data'));

      // 2. Fetch raw data from the worksheet
      const rawData = await this.connector.fetchData(this.config.worksheetName);
      console.log(`[MatrixApp] Fetched ${rawData.length} rows from "${this.config.worksheetName}"`);

      if (rawData.length === 0) {
        this._showEmpty(t('no_data_found'));
        this._isLoading = false;
        this._lastDataSignature = null;
        this._lastConfigStr = null;
        return;
      }

      // Calculate data signature and verify against previous load to prevent loop
      const configStr = JSON.stringify(this.config);
      const isConfigChanged = configStr !== this._lastConfigStr;
      const dataSig = this._getDataSignature(rawData);

      if (dataSig === this._lastDataSignature && !isConfigChanged) {
        console.log('[MatrixApp] Data and configuration are identical. Skipping render.');
        this._isLoading = false;
        return;
      }
      this._lastDataSignature = dataSig;
      this._lastConfigStr = configStr;

      if (isInitialLoad) this._showLoading(t('transforming_data'));

      // 3. Transform flat data → hierarchical matrix
      this.engine = new PivotEngine({
        rowFields: this.config.rowFields || [],
        colFields: this.config.colFields || [],
        valueFields: (this.config.valueFields || []).map(v => ({
          ...v,
          label: this.config.valueFormats?.[v.field]?.label || v.label || v.field
        })),
        showRowTotal: this.config.showRowTotal !== false
      });

      this._matrixData = this.engine.process(rawData);
      console.log('[MatrixApp] Matrix data:', this._matrixData);

      // 3. Render the matrix
      const container = document.getElementById('matrix-container');
      this.renderer = new MatrixRenderer(container, {
        showSubtotals: this.config.showSubtotals !== false,
        showGrandTotal: this.config.showGrandTotal !== false,
        cfConfigs: this.config.cfConfigs || {},
        density: this.config.density || 'normal',
        fontSize: this.config.fontSize || '12px',
        showZebra: this.config.showZebra !== false,
        showHGrid: this.config.showHGrid !== false,
        showVGrid: this.config.showVGrid !== false,
        valueFormats: (this.config && this.config.valueFormats) || {},
        onCellClick: (cellInfo) => this._onCellClick(cellInfo),
        onExpandToggle: (path, expanded) => this._onExpandToggle(path, expanded)
      });

      this.renderer.render(this._matrixData);

      // 4. Update status bar
      this._updateStatusBar();

      // 5. Show the matrix wrapper (hide welcome/loading)
      document.getElementById('matrix-wrapper').style.display = 'block';
      this._hideOverlays();

    } catch (err) {
      console.error('[MatrixApp] Refresh error:', err);
      this._showError(err);
    } finally {
      this._isLoading = false;
      // Re-register data change listeners after refreshing has finished
      if (this.config && this.config.worksheetName) {
        this.connector.registerDataChangeListener(
          this.config.worksheetName,
          () => this._onDataChanged()
        );
      }
    }
  }

  /**
   * Generates a unique signature for the worksheet data to detect real updates.
   * @private
   */
  _getDataSignature(data) {
    if (!data || data.length === 0) return 'empty';
    const len = data.length;
    const firstObj = data[0];
    const lastObj = data[len - 1];
    const midObj = data[Math.floor(len / 2)];
    
    const firstStr = JSON.stringify(firstObj);
    const midStr = JSON.stringify(midObj);
    const lastStr = JSON.stringify(lastObj);
    
    return `${len}_${firstStr}_${midStr}_${lastStr}`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Configuration Dialog
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Open the configuration dialog.
   * @private
   */
  async _openConfigDialog() {
    try {
      const configUrl = window.location.href.replace(/\/[^/]*$/, '/config.html');
      await this.connector.openConfigDialog(configUrl);

      // Reload fresh configuration (read synchronously from localStorage/settings)
      const freshConfig = this.connector.loadConfig();
      if (freshConfig) {
        this.config = Object.assign({}, this.config, freshConfig);

        // Apply theme immediately
        const theme = this.config.theme || 'theme-light';
        document.body.className = theme;
        const appEl = document.getElementById('app');
        if (appEl) appEl.className = theme;
        const wrapEl = document.getElementById('matrix-wrapper');
        if (wrapEl) wrapEl.className = `matrix-wrapper ${theme}`;

        await this._refresh();
      }
    } catch (err) {
      console.error('[MatrixApp] Config dialog error:', err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Called when data changes on the source worksheet (filter/selection change).
   * @private
   */
  _onDataChanged() {
    console.log('[MatrixApp] Data changed, refreshing...');
    // Debounce rapid changes
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refresh(), 300);
  }

  /**
   * Called when a value cell is clicked (for cross-filtering).
   * @private
   */
  async _onCellClick(cellInfo) {
    console.log('[MatrixApp] Cell clicked:', cellInfo);

    try {
      // Apply cross-filter based on the row dimension
      await this.connector.applyDashboardFilter(
        cellInfo.rowField,
        [cellInfo.rowValue],
        this.config.worksheetName
      );

      this._updateStatusBar(`Filtered: ${cellInfo.rowField} = ${cellInfo.rowValue}`);
    } catch (err) {
      console.warn('[MatrixApp] Cross-filter error:', err);
    }
  }

  /**
   * Called when a node is expanded or collapsed.
   * @private
   */
  _onExpandToggle(path, expanded) {
    console.log(`[MatrixApp] Node ${path} ${expanded ? 'expanded' : 'collapsed'}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Toolbar
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Bind toolbar button event listeners.
   * @private
   */
  _bindToolbar() {
    // Expand All
    const expandBtn = document.getElementById('btn-expand-all');
    if (expandBtn) {
      expandBtn.addEventListener('click', () => {
        if (this.renderer) this.renderer.expandAll();
      });
    }

    // Collapse All
    const collapseBtn = document.getElementById('btn-collapse-all');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        if (this.renderer) this.renderer.collapseAll();
      });
    }

    // Export Excel
    const excelBtn = document.getElementById('btn-export-excel');
    if (excelBtn) {
      excelBtn.addEventListener('click', () => {
        if (this._matrixData) {
          this.exporter.exportToExcel(this._matrixData, 'Matrix_Pro_Export');
        }
      });
    }

    // Export CSV
    const csvBtn = document.getElementById('btn-export-csv');
    if (csvBtn) {
      csvBtn.addEventListener('click', () => {
        if (this._matrixData) {
          this.exporter.exportToCSV(this._matrixData, 'Matrix_Pro_Export');
        }
      });
    }

    // Refresh
    const refreshBtn = document.getElementById('btn-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this._refresh());
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // UI State Management
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Show loading spinner.
   * @private
   */
  _showLoading(message) {
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.innerHTML = `
        <div class="loading-overlay">
          <div class="spinner"></div>
          <div class="loading-text">${message || 'Loading...'}</div>
        </div>
      `;
      overlay.style.display = 'flex';
    }
  }

  /**
   * Show welcome screen (no configuration yet).
   * @private
   */
  _showWelcome() {
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.innerHTML = `
        <div class="welcome-screen">
          <div class="welcome-icon">📊</div>
          <div class="welcome-title">${t('welcome_title')}</div>
          <div class="welcome-subtitle">
            ${t('welcome_subtitle')}
          </div>
          <button class="welcome-btn" id="btn-welcome-configure">
            ${t('btn_configure')}
          </button>
        </div>
      `;
      overlay.style.display = 'flex';

      document.getElementById('btn-welcome-configure').addEventListener('click', () => {
        this._openConfigDialog();
      });
    }
  }

  /**
   * Show prompt to configure fields (when Rows or Values shelves are empty).
   * @private
   */
  _showConfigPrompt(customMsg) {
    const overlay = document.getElementById('overlay');
    if (overlay) {
      const defaultText = t('config_prompt_default');
      overlay.innerHTML = `
        <div class="welcome-screen">
          <div class="welcome-icon">🧮</div>
          <div class="welcome-title">${t('welcome_title')}</div>
          <div class="welcome-subtitle">
            ${customMsg || defaultText}
          </div>
          <button class="welcome-btn" id="btn-prompt-refresh">
            ${t('btn_refresh_overlay')}
          </button>
        </div>
      `;
      overlay.style.display = 'flex';

      // Hide matrix wrapper while prompt is active
      const wrapEl = document.getElementById('matrix-wrapper');
      if (wrapEl) wrapEl.style.display = 'none';

      document.getElementById('btn-prompt-refresh').addEventListener('click', () => {
        this._isLoading = false;
        this._refresh();
      });
    }
  }

  /**
   * Show empty state.
   * @private
   */
  _showEmpty(message) {
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.innerHTML = `
        <div class="welcome-screen">
          <div class="welcome-icon">📭</div>
          <div class="welcome-title">${t('no_data_title')}</div>
          <div class="welcome-subtitle">${message}</div>
          <button class="welcome-btn" id="btn-empty-refresh">
            ${t('btn_refresh_overlay')}
          </button>
        </div>
      `;
      overlay.style.display = 'flex';

      document.getElementById('btn-empty-refresh').addEventListener('click', () => {
        this._refresh();
      });
    }
  }

  /**
   * Show error state.
   * @private
   */
  _showError(err) {
    const message = err instanceof Error ? err.message : String(err);
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.innerHTML = `
        <div class="error-screen">
          <div class="error-icon">⚠️</div>
          <div class="error-title">${t('error_title')}</div>
          <div class="error-message">${message}</div>
          <button class="welcome-btn" id="btn-error-retry">
            ${t('btn_retry')}
          </button>
        </div>
      `;
      overlay.style.display = 'flex';

      document.getElementById('btn-error-retry').addEventListener('click', () => {
        this.init();
      });
    }
  }

  /**
   * Hide all overlay screens.
   * @private
   */
  _hideOverlays() {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.style.display = 'none';
  }

  /**
   * Update the status bar.
   * @private
   */
  _updateStatusBar(filterStatus) {
    const statusBarEl = document.getElementById('status-bar') || document.querySelector('.status-bar');
    if (statusBarEl) {
      statusBarEl.style.display = (this.config && this.config.showStatusBar === false) ? 'none' : 'flex';
    }

    if (!this.renderer || !this._matrixData) return;

    const stats = this.renderer.getStats();
    const rowCountEl = document.getElementById('status-rows');
    const colCountEl = document.getElementById('status-columns');
    const levelsEl = document.getElementById('status-levels');
    const worksheetEl = document.getElementById('status-worksheet');
    const filterEl = document.getElementById('status-filter');
    const refreshEl = document.getElementById('status-refresh');

    if (rowCountEl) rowCountEl.textContent = stats.rows;
    if (colCountEl) colCountEl.textContent = stats.columns;
    if (levelsEl) levelsEl.textContent = stats.levels;
    const rowStr = (this.config.rowFields || []).join(', ') || 'None';
    const colStr = (this.config.colFields || []).join(', ') || 'None';
    if (worksheetEl) worksheetEl.textContent = `${this.config.worksheetName} | ${t('status_rows_label')} [${rowStr}] | ${t('status_cols_label')} [${colStr}]`;
    if (filterEl) filterEl.textContent = filterStatus || 'None';
    if (refreshEl) refreshEl.textContent = new Date().toLocaleTimeString();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const app = new MatrixApp();
  app.init();

  // Expose for debugging
  window.__matrixApp = app;
});
