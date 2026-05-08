import { faker } from '@faker-js/faker';
import { buildDescriptorMaps, isMapEntry, resolveType } from './grpcDescriptorUtils';

const generateScalarValue = (fieldType) => {
  switch (fieldType) {
    case 'TYPE_DOUBLE':
    case 'TYPE_FLOAT':
      return faker.number.float({ min: 0, max: 1000, precision: 0.01 });
    case 'TYPE_INT32':
    case 'TYPE_INT64':
    case 'TYPE_SINT32':
    case 'TYPE_SINT64':
    case 'TYPE_UINT32':
    case 'TYPE_UINT64':
    case 'TYPE_FIXED32':
    case 'TYPE_FIXED64':
      return faker.number.int({ min: 0, max: 1000 });
    case 'TYPE_BOOL':
      return faker.datatype.boolean();
    case 'TYPE_STRING':
      return faker.lorem.word();
    case 'TYPE_BYTES':
      return Buffer.from(faker.string.alpha({ length: { min: 5, max: 10 } })).toString('base64');
    default:
      return faker.lorem.word();
  }
};

const resolveMessage = (typeName, ctx) => {
  const resolved = resolveType(typeName, ctx.scope, ctx.messageMap);
  return resolved && resolved.kind === 'message' ? resolved : null;
};

const generateNestedMessage = (field, options, ctx) => {
  const resolved = resolveMessage(field.typeName, ctx);
  if (resolved && !ctx.expanding.has(resolved.fqn)) {
    ctx.expanding.add(resolved.fqn);
    const previousScope = ctx.scope;
    ctx.scope = resolved.fqn;
    const value = generateSampleMessageFromFields(resolved.descriptor.field, options, ctx);
    ctx.scope = previousScope;
    ctx.expanding.delete(resolved.fqn);
    return value;
  }
  // Legacy fallback path: kept in case an upstream caller pre-populates messageType.field
  if (field.messageType && field.messageType.field) {
    return generateSampleMessageFromFields(field.messageType.field, options, ctx);
  }
  return {};
};

const generateSingleFieldValue = (field, options, ctx) => {
  if (field.type === 'TYPE_MESSAGE') {
    return generateNestedMessage(field, options, ctx);
  }
  if (field.type === 'TYPE_ENUM') {
    return 0;
  }
  return generateScalarValue(field.type);
};

/**
 * Generates a sample message based on method parameter fields
 * @param {Object} fields - Method parameter fields
 * @param {Object} options - Generation options
 * @param {Object} [ctx] - Internal context: { messageMap, expanding, scope }
 * @returns {Object} Generated message
 */
const generateSampleMessageFromFields = (fields, options = {}, ctx) => {
  const result = {};

  if (!fields || !Array.isArray(fields)) {
    return {};
  }

  const resolvedCtx = ctx || { messageMap: new Map(), expanding: new Set(), scope: '' };

  fields.forEach((field) => {
    if (field.type === 'TYPE_MESSAGE') {
      const resolved = resolveMessage(field.typeName, resolvedCtx);

      if (resolved && isMapEntry(resolved.descriptor)) {
        const keyField = resolved.descriptor.field?.find((f) => f.name === 'key');
        const valueField = resolved.descriptor.field?.find((f) => f.name === 'value');
        if (keyField && valueField) {
          const count = options.arraySize || faker.number.int({ min: 1, max: 3 });
          const obj = {};
          for (let i = 0; i < count; i++) {
            const key = String(generateSingleFieldValue(keyField, options, resolvedCtx));
            obj[key] = generateSingleFieldValue(valueField, options, resolvedCtx);
          }
          result[field.name] = obj;
          return;
        }
      }

      if (field.label === 'LABEL_REPEATED') {
        const count = options.arraySize || faker.number.int({ min: 1, max: 3 });
        if (resolved && resolvedCtx.expanding.has(resolved.fqn)) {
          // Cycle: don't re-expand inside the array, emit empty objects
          result[field.name] = Array.from({ length: count }, () => ({}));
        } else {
          result[field.name] = Array.from({ length: count }, () =>
            generateNestedMessage(field, options, resolvedCtx)
          );
        }
      } else {
        result[field.name] = generateNestedMessage(field, options, resolvedCtx);
      }
      return;
    }

    if (field.type === 'TYPE_ENUM') {
      result[field.name] = field.label === 'LABEL_REPEATED' ? [0] : 0;
      return;
    }

    const value = generateScalarValue(field.type);

    if (field.label === 'LABEL_REPEATED') {
      const count = options.arraySize || faker.number.int({ min: 1, max: 3 });
      result[field.name] = Array.from({ length: count }, () => value);
    } else {
      result[field.name] = value;
    }
  });

  return result;
};

/**
 * Extracts field definitions from a method's request type
 * @param {Object} method - The gRPC method
 * @returns {Array|null} Array of field definitions or null
 */
const getMethodRequestFields = (method) => {
  try {
    if (method.requestType?.type?.field) {
      return method.requestType.type.field;
    }

    if (method.requestType?.field) {
      return method.requestType.field;
    }

    if (method.requestType?.type) {
      return method.requestType.type;
    }
  } catch (error) {
    console.error('Error extracting method request fields:', error);
    return null;
  }
};

/**
 * Generates a sample gRPC message based on a method definition
 * @param {Object} method - gRPC method definition
 * @param {Object} options - Generation options
 * @returns {Object} Generated message
 */
export const generateGrpcSampleMessage = (method, options = {}) => {
  try {
    if (!method) {
      return {};
    }

    const fields = getMethodRequestFields(method);

    if (!fields) {
      return {};
    }

    const { messageMap } = buildDescriptorMaps(method.requestType?.fileDescriptorProtos);

    let scope = '';
    const requestTypeName = method.requestType?.type?.name;
    if (requestTypeName) {
      const entryResolved = resolveType(requestTypeName, '', messageMap);
      if (entryResolved && entryResolved.kind === 'message') {
        scope = entryResolved.fqn;
      }
    }

    const ctx = {
      messageMap,
      expanding: new Set(scope ? [scope] : []),
      scope
    };

    return generateSampleMessageFromFields(fields, options, ctx);
  } catch (error) {
    console.error('Error generating gRPC sample message:', error);
    return {};
  }
};
