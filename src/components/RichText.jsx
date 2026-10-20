import React from 'react';
import { sanitizeHtml } from '../lib/richtext/sanitize.js';

/** Renders stored comment HTML (re-sanitized on every render). */
export default function RichText({ html, className = '' }) {
  return <div className={`rt ${className}`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}
