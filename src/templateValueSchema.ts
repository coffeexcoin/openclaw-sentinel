import { Type } from "@sinclair/typebox";

export const TEMPLATE_VALUE_SCHEMA_ID =
  "https://schemas.coffeexcoin.dev/openclaw-sentinel/template-value.json";

export const TemplateValueSchema: any = Type.Recursive(
  (Self) =>
    Type.Union([
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Null(),
      Type.Array(Self),
      Type.Record(Type.String(), Self),
    ]),
  { $id: TEMPLATE_VALUE_SCHEMA_ID },
);
