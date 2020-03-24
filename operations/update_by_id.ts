import get from 'lodash/get';
import createDebug from 'debug';
import { Context } from '../context';
import { UpdateItemInput, Converter, AttributeMap, AttributeValue, Key } from 'aws-sdk/clients/dynamodb';
import { getRootCollection, assemblePrimaryKeyValue, unwrap, assembleIndexedValue, invertMap, findMatchingPath } from '../base/util';
import { KeyPath } from '../base/access_pattern';
import { WrappedDocument, DocumentWithId } from '../base/common';
import { InvalidUpdatesException, InvalidUpdateValueException, IndexNotFoundException } from '../base/exceptions';
import { Collection } from '../base/collection';
import { SecondaryIndexLayout } from '../base/layout';
import debugDynamo from '../debug/debugDynamo';
import { isSafeAttributeName } from './expression_util';

/** @internal */
const debug = createDebug('dynaglue:operations:updateById');

/**
  * An update object, where the key paths are specified as keys and the values
  * as the new field values.
  *
  * Keep in mind, that although this is a partial update, you need to specify
  * all the keys for a composite key in an access pattern - it cannot partially
  * update composite index values.
  */
export type SetValuesDocument = {
  [path: string]: any;
};

/**
  * The set of updates to apply to a document.
  */
export type Updates = SetValuesDocument;

/**
  * @internal
  */
export const extractUpdateKeyPaths = (updates: Updates): KeyPath[] =>
  Object.keys(updates).map(updatePath => updatePath.split('.'));

/**
  * @internal
  */
export const createUpdateActionForKey = (
  collectionName: string,
  keyType: 'partition' | 'sort',
  keyPaths: KeyPath[], indexLayout: SecondaryIndexLayout,
  updates: Updates
): { attributeName: string; value?: string } | undefined => {
  const updateKeyPaths = extractUpdateKeyPaths(updates);
  const matchingUpdatePaths = keyPaths.map(partitionKey => findMatchingPath(updateKeyPaths, partitionKey));
  const attributeName = (keyType === 'sort' ? indexLayout.sortKey as string : indexLayout.partitionKey);
  debug('createUpdateActionForKey: collection=%s keyType=%s keyPaths=%o attributeName=%s', collectionName, keyType, keyPaths, attributeName);
  if (matchingUpdatePaths.every(updatePath => updatePath === undefined)) {
    debug('createUpdateActionForKey: no updates to %s key in collection %s', keyType, collectionName);
    return undefined;
  }
  if (keyType === 'partition' && !matchingUpdatePaths.every(updatePath => updatePath !== undefined)) {
    throw new InvalidUpdatesException(`all values are required for ${keyType} access pattern with keys {${keyPaths.map(kp => kp.join('.')).join(', ')}}`)
  } 
  debug('createUpdateActionForKey: key to be updated matchingUpdatePaths=%o', matchingUpdatePaths);
  const updateValues = keyPaths.map((keyPath, index) => {
    const matchingUpdatePath = matchingUpdatePaths[index];
    if (!matchingUpdatePath) {
      return undefined;
    }
    let value = updates[matchingUpdatePath.join('.')];
    if (keyPath.length !== matchingUpdatePath.length) {
      const difference = keyPath.slice(matchingUpdatePath.length);
      value = get(value, difference);
    }
    return value;
  });

  return {
    attributeName,
    value: assembleIndexedValue(keyType, collectionName, updateValues),
  };
}

/**
  * @internal
  */
export const findCollectionIndex = (
  collection: Collection,
  indexName: string
): SecondaryIndexLayout => {
  const layout = collection.layout.findKeys?.find(fk => fk.indexName === indexName);
  if (!layout) {
    throw new IndexNotFoundException(indexName);
  }

  return layout;
}

/**
  * @internal
  */
export type Action = {
  action: string;
  expressionAttributeValue: [string, any];
  expressionAttributeNames: [string, string][];
};

export type NameMapper = {
  map(name: string): string;
  get(): { [mappedName: string]: string };
};

/**
 * @internal
 *
 * Create a mapper for generating `ExpressionAttributeNames`
 * entries. [[map]] will generate a new attribute name
 * that can be used in expressions for every attribute it
 * is given.
 *
 * The value for `ExpressionAttributeNames` can be
 * returned by [[get]] at the end.
 */
export const createNameMapper = (): NameMapper => {
  let currentIndex = 0;
  const attributeNameMap = new Map<string, string>();

  attributeNameMap.set('value', '#value');

  return {
    /**
     * Generate an expression attribute name for 
     * `name` (if necessary - values not requiring
     * escaping will be returned as-is)
     */
    map(name: string): string {
      if (isSafeAttributeName(name)) {
        return name;
      }
      let nameMapping = attributeNameMap.get(name);
      if (!nameMapping) {
        nameMapping = `#attr${currentIndex++}`;
        attributeNameMap.set(name, nameMapping);
      }
      return nameMapping;
    },

    /**
     * Return the map of attribute names
     */
    get(): Record<string, string> {
      return invertMap(attributeNameMap);
    }
  };
};

export type ValueMapper = {
  map(value: any): string;
  get(): { [mappedName: string]: AttributeValue };
};

/**
 * @internal
 *
 * Create a mapper for generating `ExpressionAttributeValues`
 * entries. [[map]] will generate a new attribute name
 * that can be used in expressions for every attribute it
 * is given.
 *
 * The value for `ExpressionAttributeValues` can be
 * returned by [[get]] at the end.
 */
export const createValueMapper = (): ValueMapper => {
  let currentIndex = 0;
  const valueMap = new Map<string, AttributeValue>();

  return {
    /**
     * Given `value`, marshall it to DynamoDB format, store
     * it internally, and return the `:value` reference that
     * can be used in expressions
     */
    map(value: any): string {
      const valueKey = `:value${currentIndex++}`;
      const convertedValue = Converter.input(value);
      valueMap.set(valueKey, convertedValue);
      return valueKey;
    },

    /**
     * Get the map for `ExpressionAttributeValues`
     */
    get(): { [key: string]: AttributeValue } {
      return Array.from(valueMap).reduce((obj, [key, value]) => {
        obj[key] = value;
        return obj;
      }, {} as { [key: string]: AttributeValue });
    }
  };
};

/**
 * @internal
 *
 * Given the set of updates, create the SET and DELETE
 * actions for the access patterns that also have to be
 * changed.
 */
export const mapAccessPatterns = (
  collection: Collection,
  { nameMapper, valueMapper }: { nameMapper: NameMapper; valueMapper: ValueMapper },
  updates: Updates,
): {
  setActions: string[];
  deleteActions: string[];
} => {
  const expressionSetActions: string[] = [];
  const expressionDeleteActions: string[] = [];
  if (!collection.accessPatterns) {
    return { setActions: expressionSetActions, deleteActions: expressionDeleteActions };
  }
  for (const { indexName, partitionKeys, sortKeys } of collection.accessPatterns) {
    if (partitionKeys.length > 0) {
      const layout = findCollectionIndex(collection, indexName);
      const update = createUpdateActionForKey(collection.name, 'partition', partitionKeys, layout, updates);
      if (update) {
        debug('mapAccessPatterns: adding set action for partition key in collection %s: %o', collection.name, update);
        const nameMapping = nameMapper.map(update.attributeName);
        const valueMapping = valueMapper.map(update.value);
        expressionSetActions.push(`${nameMapping} = ${valueMapping}`);
      }
    }
    if (sortKeys && sortKeys.length > 0) {
      const layout = findCollectionIndex(collection, indexName);
      const update = createUpdateActionForKey(collection.name, 'sort', sortKeys, layout, updates);
      if (update) {
        debug('mapAccessPatterns: adding set/delete action for sort key in collection %s: %o', collection.name, update);
        if (typeof update.value !== 'undefined') {
          const nameMapping = nameMapper.map(update.attributeName);
          const valueMapping = valueMapper.map(update.value);
          expressionSetActions.push(`${nameMapping} = ${valueMapping}`);
        } else {
          const nameMapping = nameMapper.map(update.attributeName);
          expressionDeleteActions.push(nameMapping);
        }
      }
    }
  }
  return { setActions: expressionSetActions, deleteActions: expressionDeleteActions };
}

/**
 * @internal
 *
 * Performs an update operation for the given collection and key
 * value. Shares most of the code between updateById and updateChildById
 *
 */
export async function updateInternal(ctx: Context, collection: Collection, key: Key, updates: Updates): Promise<DocumentWithId> {
  const updatePaths: string[] = Object.keys(updates);
  if (updatePaths.length === 0) {
    throw new InvalidUpdatesException('There must be at least one update path in the updates object');
  }
  const updateKeyPaths: KeyPath[] = extractUpdateKeyPaths(updates);

  const nameMapper = createNameMapper();
  const valueMapper = createValueMapper();
  let expressionSetActions: string[] = [];
  let expressionDeleteActions: string[] = [];
  for (const [index, updatePath] of updatePaths.entries()) {
    const updateKeyPath = updateKeyPaths[index];

    const value = updates[updatePath];
    if (typeof value === 'undefined') {
      throw new InvalidUpdateValueException(updatePath, 'value must not be undefined');
    }
    const valueName = valueMapper.map(value);

    const expressionAttributeNameParts = ['#value', ...updateKeyPath.map(part => nameMapper.map(part))];
    expressionSetActions.push(`${expressionAttributeNameParts.join('.')} = ${valueName}`);
  }

  const { setActions: additionalSetActions, deleteActions: additionalDeleteActions } = 
    mapAccessPatterns(collection, { nameMapper, valueMapper }, updates);
  expressionSetActions = [...expressionSetActions, ...additionalSetActions];
  expressionDeleteActions = [...expressionDeleteActions, ...additionalDeleteActions];

  const expressionAttributeNames = nameMapper.get();
  const expressionAttributeValues = valueMapper.get();
  const updateExpression = 
    (expressionSetActions.length ? ` SET ${expressionSetActions.join(', ')}` : '') +
    (expressionDeleteActions.length ? ` REMOVE ${expressionDeleteActions.join(', ')}` : '');

  const updateItem: UpdateItemInput = {
    TableName: collection.layout.tableName,
    Key: key,
    ReturnValues: 'ALL_NEW',
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    UpdateExpression: updateExpression.trim(),
  };

  debugDynamo('UpdateItem', updateItem);

  const result = await ctx.ddb.updateItem(updateItem).promise();
  const unmarshalledAttributes = Converter.unmarshall(result.Attributes as AttributeMap);
  const updatedDocument = unwrap(unmarshalledAttributes as WrappedDocument);
  return updatedDocument;
}

/**
  * Update a document using its `_id`.
  *
  * This operation allows you to do a partial update of a collection document i.e. without
  * specifying all the values (it uses DynamoDB`s `UpdateItem` operation).
  *
  * At this time, the `updates` value just updates specified key paths on the target document.
  * 
  * If some of the update key paths are indexed values, the indexes will also be updated. Because
  * of this, you must specify all the key values in an access pattern to ensure indexes are
  * updated consistently.
  *
  * @param ctx the context
  * @param collectionName the collection to update
  * @param objectId the `_id` value of the object to update
  * @param updates the set of updates to apply.
  * @returns the updated object value in its entirety.
  * @throws {CollectionNotFoundException} collection not found
  * @throws {InvalidUpdatesException} thrown when the updates object is invalid or incomplete
  * @throws {InvalidUpdateValueException} thrown when one of the update values is an invalid type
  */
export async function updateById(
  ctx: Context,
  collectionName: string,
  objectId: string,
  updates: Updates
): Promise<DocumentWithId> {
  const collection = getRootCollection(ctx, collectionName);

  const key = {
    [collection.layout.primaryKey.partitionKey]: { S: assemblePrimaryKeyValue(collectionName, objectId) },
    [collection.layout.primaryKey.sortKey]: { S: assemblePrimaryKeyValue(collectionName, objectId) },
  };
  return updateInternal(ctx, collection, key, updates);
};

