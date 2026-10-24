// Region profiles: everything that differs from one country to the next, in ONE registry.
// Nothing outside this folder should hard-code "GST", "CGST/SGST", "₹" or "GSTIN" - ask the active region instead.
// Add a country with registerRegion({...}) (or one more entry below); communities pick theirs in Community setup → Country.
//
//   tax.name      what the tax is called on bills ("GST", "VAT", "Sales tax")
//   tax.split     how a tax line is shown. India splits GST into CGST + SGST; most countries show one line.
//   tax.idLabel   the label for the community's tax registration number (GSTIN, TRN, VAT no.)
//   gateways      ids of the payment providers that work in that country (see lib/payments/gateways.js)
//   payments      { online: modes taken through the gateway, upiQr: show UPI QR / deep link }; Cash, Cheque, Bank transfer are everywhere
//   defaults      applied to a community's money/date settings until it overrides them in Community setup
import { syncPaymentModes } from './paymentModes.js';
const REGIONS = {};

export function registerRegion(r) { REGIONS[r.code] = { gateways: ['simulated'], ...r }; return REGIONS[r.code]; }
export const listRegions = () => Object.values(REGIONS);
export const getRegionByCode = (code) => REGIONS[code] || REGIONS.IN;

registerRegion({ code: 'IN', timeZone: 'Asia/Kolkata', name: 'India', currency: { code: 'INR', symbol: '₹' }, locale: 'en-IN',
  tax: { name: 'GST', idLabel: 'GSTIN', defaultRate: 18, split: [{ label: 'CGST', share: 0.5 }, { label: 'SGST', share: 0.5 }] },
  defaults: { currencySymbol: '₹', numberFormat: 'Indian (12,34,567)', fyStartMonth: 'April', amountUnit: 'Lakh / crore' },
  phone: { dial: '+91', digits: 10 }, payments: { online: ['UPI', 'Card', 'Net banking'], upiQr: true }, gateways: ['razorpay', 'simulated'] });
registerRegion({ code: 'AE', timeZone: 'Asia/Dubai', name: 'United Arab Emirates', currency: { code: 'AED', symbol: 'AED ' }, locale: 'en-AE',
  tax: { name: 'VAT', idLabel: 'TRN', defaultRate: 5, split: [{ label: 'VAT', share: 1 }] },
  defaults: { currencySymbol: 'AED ', numberFormat: 'International (1,234,567)', fyStartMonth: 'January', amountUnit: 'Thousand / million' },
  phone: { dial: '+971', digits: 9 }, payments: { online: ['Card', 'Apple Pay'] }, gateways: ['stripe', 'simulated'] });
registerRegion({ code: 'GB', timeZone: 'Europe/London', name: 'United Kingdom', currency: { code: 'GBP', symbol: '£' }, locale: 'en-GB',
  tax: { name: 'VAT', idLabel: 'VAT no.', defaultRate: 20, split: [{ label: 'VAT', share: 1 }] },
  defaults: { currencySymbol: '£', numberFormat: 'International (1,234,567)', fyStartMonth: 'April', amountUnit: 'Thousand / million' },
  phone: { dial: '+44', digits: 10 }, payments: { online: ['Card', 'Direct debit'] }, gateways: ['stripe', 'simulated'] });
registerRegion({ code: 'US', timeZone: 'America/New_York', name: 'United States', currency: { code: 'USD', symbol: '$' }, locale: 'en-US',
  tax: { name: 'Sales tax', idLabel: 'Tax ID', defaultRate: 0, split: [{ label: 'Sales tax', share: 1 }] },
  defaults: { currencySymbol: '$', numberFormat: 'International (1,234,567)', fyStartMonth: 'January', amountUnit: 'Thousand / million' },
  phone: { dial: '+1', digits: 10 }, payments: { online: ['Card', 'ACH'] }, gateways: ['stripe', 'simulated'] });
registerRegion({ code: 'SG', timeZone: 'Asia/Singapore', name: 'Singapore', currency: { code: 'SGD', symbol: 'S$' }, locale: 'en-SG',
  tax: { name: 'GST', idLabel: 'GST reg. no.', defaultRate: 9, split: [{ label: 'GST', share: 1 }] },
  defaults: { currencySymbol: 'S$', numberFormat: 'International (1,234,567)', fyStartMonth: 'January', amountUnit: 'Thousand / million' },
  phone: { dial: '+65', digits: 8 }, payments: { online: ['Card', 'PayNow'] }, gateways: ['stripe', 'simulated'] });
registerRegion({ code: 'AU', timeZone: 'Australia/Sydney', name: 'Australia', currency: { code: 'AUD', symbol: 'A$' }, locale: 'en-AU',
  tax: { name: 'GST', idLabel: 'ABN', defaultRate: 10, split: [{ label: 'GST', share: 1 }] },
  defaults: { currencySymbol: 'A$', numberFormat: 'International (1,234,567)', fyStartMonth: 'July', amountUnit: 'Thousand / million' },
  phone: { dial: '+61', digits: 9 }, payments: { online: ['Card', 'PayID'] }, gateways: ['stripe', 'simulated'] });

let activeCode = 'IN';
export const setActiveRegion = (code) => { activeCode = REGIONS[code] ? code : 'IN'; syncPaymentModes(REGIONS[activeCode]); };
export const region = () => getRegionByCode(activeCode);

syncPaymentModes(REGIONS[activeCode]);
