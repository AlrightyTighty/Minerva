import { Ajv } from "ajv";
import type { FastifySchemaCompiler } from "fastify";

const options = { useDefaults: true, removeAdditional: true, allErrors: false };

// Query strings and path parameters arrive as text, so numbers in them (?limit=10) have to be coerced.
const textInputs = new Ajv({ ...options, coerceTypes: true });

// A JSON body already has real types, so nothing is coerced: a number where text is expected, or the text "true"
// where a boolean is expected, is a mistake in the request and not something to quietly accept. (Fastify's own
// default also wraps a lone value in a list, so "f1" would pass as ["f1"].)
const jsonBodies = new Ajv(options);

export const validatorCompiler: FastifySchemaCompiler<unknown> = ({ schema, httpPart }) => {
  const validate = (httpPart === "body" ? jsonBodies : textInputs).compile(schema as object);
  return (data) => (validate(data) ? { value: data } : { error: new Error(textInputs.errorsText(validate.errors)) });
};
