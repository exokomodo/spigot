/**
 * Minimal, dependency free XML serialization. Only the pieces RSS 2.0 needs:
 * elements, attributes, escaped text nodes and CDATA sections.
 */

export interface XmlAttributes {
  readonly [name: string]: string | number | boolean | undefined;
}

/** Marks a string as raw content that should be wrapped in a CDATA section. */
export interface XmlCdata {
  readonly cdata: string;
}

/** Either an escaped text node or a CDATA section. */
export type XmlText = string | XmlCdata;

export interface XmlElement {
  readonly name: string;
  readonly attributes?: XmlAttributes;
  /** Rendered as the element body. Ignored when `children` is non-empty. */
  readonly text?: XmlText;
  readonly children?: readonly XmlElement[];
}

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

const INDENT = "  ";

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Wraps a value so it is emitted as a CDATA section rather than escaped text. */
export function cdata(value: string): XmlCdata {
  return { cdata: value };
}

export function isCdata(value: XmlText): value is XmlCdata {
  return typeof value !== "string";
}

/**
 * Escapes the five XML predefined entities. Safe for both text nodes and
 * attribute values, so a single function covers every position we emit.
 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

/**
 * Renders a CDATA section. A literal `]]>` inside the payload would close the
 * section early, so it is split across two sections.
 */
export function renderCdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export function renderXmlText(value: XmlText): string {
  return isCdata(value) ? renderCdata(value.cdata) : escapeXml(value);
}

function renderAttributes(attributes: XmlAttributes | undefined): string {
  if (attributes === undefined) {
    return "";
  }
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join("");
}

/** Renders a single element, and its subtree, as indented XML. */
export function renderXmlElement(element: XmlElement, depth = 0): string {
  const indent = INDENT.repeat(depth);
  const open = `${indent}<${element.name}${renderAttributes(element.attributes)}`;
  const children = element.children ?? [];
  if (children.length > 0) {
    const body = children.map((child) => renderXmlElement(child, depth + 1));
    return [`${open}>`, ...body, `${indent}</${element.name}>`].join("\n");
  }
  if (element.text === undefined) {
    return `${open} />`;
  }
  return `${open}>${renderXmlText(element.text)}</${element.name}>`;
}

/** Renders a complete document: XML declaration, root element, trailing newline. */
export function renderXmlDocument(root: XmlElement): string {
  return `${[XML_DECLARATION, renderXmlElement(root)].join("\n")}\n`;
}
