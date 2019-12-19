import VError from 'verror';

export class ConflictException extends VError {
  constructor(message: string, id: string) {
    super({ info: { id }, name: 'conflict.error' }, message);
  }
}
export class InvalidIdException extends VError {
  constructor(id: string) {
    super({ info: { id }, name: 'invaild_id.error' }, 'The provided document has an invalid ID');
  }
}

export class CollectionNotFoundException extends VError {
  constructor(collection: string) {
    super({ info: { collection }, name: 'collection_not_found.error' }, `Collection not found: '${collection}'`);
  }
}

export class IndexNotFoundException extends VError {
  constructor (index: string) {
    super({ info: { index }, name: 'index_not_found.error' }, `Index not found: ${index}`);
  }
}

export class ConfigurationException extends VError {
  constructor(message: string, options: VError.Options = {}) {
    super({
      ...options,
      name: 'configuration.error',
    }, message);
  }
}

export class PersistenceException extends VError {}

export class InvalidQueryException extends VError {
  constructor(message: string, { collection, query }: { collection: string; query: object }) {
    super({
      info: {
        collection,
        query,
      },
      name: 'invalid_query.error',
    }, message);
  }
}

export class InvalidUpdateException extends VError {
  constructor(message: string) {
    super({
      name: 'invalid_update.error',
    }, message);
  }
}

export class ExistingItemNotFoundForUpdateException extends VError {
  constructor(message: string, id: string) {
    super({ info: { id }, name: 'existing_item_not_found_for_update.error' }, message);
  }
}