const clone = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

class MockTimestamp {
  constructor(millis = Date.now()) {
    this._millis = millis
  }

  static now() {
    return new MockTimestamp(Date.now())
  }

  static fromMillis(millis) {
    return new MockTimestamp(millis)
  }

  toMillis() {
    return this._millis
  }
}

class MockDocSnapshot {
  constructor(data) {
    this._data = data
  }

  get exists() {
    return this._data !== undefined
  }

  data() {
    return this._data ? clone(this._data) : undefined
  }

  get(field) {
    return this._data ? this._data[field] : undefined
  }
}

class MockDocumentReference {
  constructor(db, path) {
    this._db = db
    this.path = path
  }

  get id() {
    const parts = this.path.split('/')
    return parts[parts.length - 1]
  }

  collection(name) {
    return new MockCollectionReference(this._db, `${this.path}/${name}`)
  }

  async get() {
    const data = this._db.getRaw(this.path)
    return new MockDocSnapshot(data ? clone(data) : undefined)
  }

  async set(data, options = {}) {
    const existing = this._db.getRaw(this.path)
    if (options && options.merge && existing) {
      this._db.setRaw(this.path, { ...existing, ...clone(data) })
    } else {
      this._db.setRaw(this.path, clone(data))
    }
  }
}

class MockCollectionReference {
  constructor(db, path) {
    this._db = db
    this._path = path
  }

  doc(id) {
    const docId = id || this._db.generateId()
    return new MockDocumentReference(this._db, `${this._path}/${docId}`)
  }
}

class MockTransaction {
  constructor(db) {
    this._db = db
    this._writes = new Map()
  }

  async get(ref) {
    const pending = this._writes.get(ref.path)
    const base = pending || this._db.getRaw(ref.path)
    return new MockDocSnapshot(base ? clone(base) : undefined)
  }

  set(ref, data) {
    this._writes.set(ref.path, clone(data))
  }

  update(ref, data) {
    const existing = this._writes.get(ref.path) || this._db.getRaw(ref.path)
    if (!existing) {
      throw new Error('Document does not exist')
    }
    this._writes.set(ref.path, { ...clone(existing), ...clone(data) })
  }

  commit() {
    for (const [path, value] of this._writes.entries()) {
      this._db.setRaw(path, value)
    }
  }
}

class MockFirestore {
  constructor(initialData = {}) {
    this._store = new Map()
    this._idCounter = 0
    for (const [path, value] of Object.entries(initialData)) {
      this.setRaw(path, value)
    }
  }

  collection(path) {
    return new MockCollectionReference(this, path)
  }

  generateId() {
    this._idCounter += 1
    return `mock-id-${this._idCounter}`
  }

  async runTransaction(fn) {
    const tx = new MockTransaction(this)
    const result = await fn(tx)
    tx.commit()
    return result
  }

  getRaw(path) {
    const value = this._store.get(path)
    return value ? clone(value) : undefined
  }

  setRaw(path, data) {
    this._store.set(path, clone(data))
  }

  getDoc(path) {
    return this.getRaw(path)
  }

  listCollection(path) {
    const prefix = `${path}/`
    const results = []
    for (const [docPath, value] of this._store.entries()) {
      if (docPath.startsWith(prefix)) {
        const remainder = docPath.slice(prefix.length)
        if (!remainder.includes('/')) {
          results.push({ id: remainder, data: clone(value) })
        }
      }
    }
    return results
  }
}

module.exports = {
  MockFirestore,
  MockTimestamp,
}
