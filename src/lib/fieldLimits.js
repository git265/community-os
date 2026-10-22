// The same sizes the server holds every register field to (backend FieldLimits): a form stops the typing at the limit instead of the save
// failing. A field can name its own (`maxLength` in the schema).
const LONG = new Set(['body', 'description', 'details', 'notes', 'note', 'message', 'intro', 'footer', 'headerText', 'offeringsIntro', 'passMessage', 'remarks', 'reason',
  'decisionNote', 'reviewNote', 'statusReason', 'summary', 'summaryReport', 'warrantyTerms', 'error', 'address', 'caption', 'purpose']);
export const SHORT_TEXT = 1000; export const LONG_TEXT = 20000;
export const maxLengthFor = (field) => Number(field?.maxLength) || (field?.type === 'textarea' || LONG.has(field?.key) ? LONG_TEXT : SHORT_TEXT);
