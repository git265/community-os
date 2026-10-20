package com.communityos.port;

import java.util.Map;

/** PORT: a GST data source (a GSP such as ClearTax / Masters India / Zoho, or the GSTN APIs). Returns plain maps = the JSON the UI expects. */
public interface GstProvider {
    String id();
    Map<String, Object> health();
    Map<String, Object> lookupGstin(String gstin);
    /** body: { vendorGstin, invoiceNo, invoiceDate, source } */
    Map<String, Object> lookupInvoice(Map<String, Object> body);
}
