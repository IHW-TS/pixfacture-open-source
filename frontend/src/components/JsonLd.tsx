type JsonLdValue = Record<string, unknown> | Record<string, unknown>[];

const safeSerialize = (value: JsonLdValue): string => {
  return JSON.stringify(value).replace(/</g, "\\u003c");
};

export default function JsonLd({ data, id }: { data: JsonLdValue; id?: string }) {
  return <script id={id} type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeSerialize(data) }} />;
}
