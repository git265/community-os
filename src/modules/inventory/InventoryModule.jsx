import React, { useState } from 'react';
import InvoiceImport from './InvoiceImport.jsx';
import ExcelImport from './ExcelImport.jsx';
import InventoryRules from './InventoryRules.jsx';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import SectionPage from '../../components/SectionPage.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';

export const stockStatusFor = (qty, min) => {
  const q = Number(qty) || 0;
  if (q <= 0) return 'Out of stock';
  return q <= (Number(min) || 0) ? 'Low' : 'In stock';
};

function inventoryStatCards(records) {
  const low = records.filter((r) => r.stockStatus === 'Low').length;
  const out = records.filter((r) => r.stockStatus === 'Out of stock').length;
  return [
    { label: 'Items tracked', value: records.length, sub: `${new Set(records.map((r) => r.category)).size} categories` },
    { label: 'Low stock', value: low, sub: 'At or below re-order level' },
    { label: 'Out of stock', value: out },
  ];
}

export default function InventoryModule() {
  const [importing, setImporting] = useState(false);
  const [excel, setExcel] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const canAdd = canWriteCollection(COLLECTIONS.INVENTORY, getPrincipal());
  return (
    <>
    {importing && <InvoiceImport onClose={() => setImporting(false)} />}
    {excel && <ExcelImport onClose={() => setExcel(false)} />}
    {rulesOpen && <InventoryRules onClose={() => setRulesOpen(false)} />}
    <SectionPage
      headerExtra={(
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canAdd && <button type="button" className="btn secondary" data-testid="inv-from-invoice" onClick={() => setImporting(true)}>📄 Add from invoice</button>}
          {canAdd && <button type="button" className="btn secondary" data-testid="inv-from-excel" onClick={() => setExcel(true)}>📥 Import from Excel</button>}
          <button type="button" className="btn secondary" data-testid="inv-rules" onClick={() => setRulesOpen(true)}>⚙ Mapping rules</button>
        </div>
      )}
      sectionId={COLLECTIONS.INVENTORY}
      title="Inventory"
      description="Supplies in stock for each category — spare parts, consumables and tools — with invoices and warranty papers attached."
      recordName="inventory item"
      formHelp="Record a supply item, how many are in stock and where it is kept. Set a re-order level to be warned when it runs low; attach invoices or spec sheets."
      statCards={inventoryStatCards}
      search
      filters={[{ key: 'location', label: 'All locations' }, { key: 'category', label: 'All categories' }, { key: 'stockStatus', label: 'All stock levels' }]}
      baseSort={{ key: 'category', dir: 'asc' }}
      onBeforeSave={(draft) => { draft.stockStatus = stockStatusFor(draft.quantity, draft.minStock); return ''; }}
    />
    </>
  );
}
