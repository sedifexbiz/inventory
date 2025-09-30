const clone = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value)

const isMockIncrement = value => isPlainObject(value) && value.__mockIncrement !== undefined

const isMockDelete = value => isPlainObject(value) && value.__mockDelete === true

const resolveUpdateValue = (currentValue, incomingValue) => {
  if (isMockIncrement(incomingValue)) {
    const incrementBy = Number(incomingValue.__mockIncrement)
    const baseValue = Number.isFinite(Number(currentValue)) ? Number(currentValue) : 0
    return baseValue + incrementBy
  }
  return clone(incomingValue)
}

const applyFieldUpdate = (target, pathSegments, value) => {
  if (pathSegments.length === 0) {
    return target
  }

  const [head, ...rest] = pathSegments
  const result = { ...target }

  if (rest.length === 0) {
    if (isMockDelete(value)) {
      delete result[head]
      return result
    }

    if (isPlainObject(value) && !isMockIncrement(value)) {
      const current = isPlainObject(result[head]) ? result[head] : {}
      result[head] = applyMerge(current, value)
      return result
    }

    result[head] = resolveUpdateValue(result[head], value)
    return result
  }

  const current = isPlainObject(result[head]) ? result[head] : {}
  result[head] = applyFieldUpdate(current, rest, value)
  if (isMockDelete(value) && Object.keys(result[head]).length === 0) {
    delete result[head]
  }
  return result
}

const applyMerge = (existing = {}, updates = {}) => {
  let result = { ...clone(existing) }
  for (const [key, value] of Object.entries(updates || {})) {
    const segments = key.split('.')
    result = applyFieldUpdate(result, segments, value)
  }
  return result
}

const getFieldValue = (record, fieldPath) => {
  if (!record || typeof record !== 'object') {
    return undefined
  }
  if (!fieldPath) {
    return record
  }
  const segments = fieldPath.split('.')
  let current = record
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return undefined
    }
    current = current[segment]
    if (current === undefined) {
      return undefined
    }
  }
  return current
}

const normalizeComparableValue = value => {
  if (value && typeof value === 'object') {
    if (typeof value._millis === 'number') {
      return value._millis
    }
    if (typeof value._seconds === 'number') {
      const nanos = typeof value._nanoseconds === 'number' ? value._nanoseconds : 0
      return value._seconds * 1000 + nanos / 1_000_000
    }
  }
  if (value && typeof value.toMillis === 'function') {
    try {
      return value.toMillis()
    } catch (error) {
      return value
    }
  }
  return value
}

const compareWithOperator = (left, operator, right) => {
  switch (operator) {
    case '==':
      return left === right
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    case '>=':
      return left >= right
    default:
      throw new Error(`Unsupported operator: ${operator}`)
  }
}

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

  toDate() {
    return new Date(this._millis)
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
    if (options && options.merge) {
      this._db.setRaw(this.path, applyMerge(existing || {}, data))
    } else {
      this._db.setRaw(this.path, applyMerge({}, data))
    }
  }

  async update(data) {
    const existing = this._db.getRaw(this.path)
    if (!existing) {
      const error = new Error('Document does not exist')
      error.code = 'not-found'
      throw error
    }
    this._db.setRaw(this.path, applyMerge(existing, data))
  }

  async delete() {
    this._db.deleteRaw(this.path)
  }
}

class MockQueryDocumentSnapshot {
  constructor(db, path, data) {
    this._db = db
    this.ref = new MockDocumentReference(db, path)
    this.id = this.ref.id
    this._data = clone(data)
  }

  data() {
    return this._data ? clone(this._data) : undefined
  }

  get(field) {
    const value = this._data ? getFieldValue(this._data, field) : undefined
    return value === undefined ? undefined : clone(value)
  }
}

class MockQuerySnapshot {
  constructor(docs) {
    this.docs = docs
    this.size = docs.length
    this.empty = docs.length === 0
  }

  forEach(callback, thisArg) {
    this.docs.forEach(doc => {
      callback.call(thisArg, doc)
    })
  }
}

class MockQuery {
  constructor(db, path, constraints = [], orderings = [], limitValue = null) {
    this._db = db
    this._path = path
    this._constraints = constraints
    this._orderings = orderings
    this._limit = typeof limitValue === 'number' ? limitValue : null
  }

  where(field, opStr, value) {
    return new MockQuery(
      this._db,
      this._path,
      [...this._constraints, { field, opStr, value }],
      this._orderings,
      this._limit,
    )
  }

  orderBy(field, direction = 'asc') {
    return new MockQuery(
      this._db,
      this._path,
      this._constraints,
      [...this._orderings, { field, direction }],
      this._limit,
    )
  }

  limit(count) {
    return new MockQuery(this._db, this._path, this._constraints, this._orderings, count)
  }

  async get() {
    const entries = this._db.listCollection(this._path)
    let results = entries.filter(entry => {
      return this._constraints.every(constraint => {
        const fieldValue = getFieldValue(entry.data, constraint.field)
        const left = normalizeComparableValue(fieldValue)
        const right = normalizeComparableValue(constraint.value)
        return compareWithOperator(left, constraint.opStr, right)
      })
    })

    for (const ordering of this._orderings) {
      if (!ordering || !ordering.field) {
        continue
      }
      const direction = ordering.direction === 'desc' ? -1 : 1
      results = results.sort((a, b) => {
        const left = normalizeComparableValue(getFieldValue(a.data, ordering.field))
        const right = normalizeComparableValue(getFieldValue(b.data, ordering.field))
        if (left === right) {
          return 0
        }
        if (left === undefined) {
          return -1 * direction
        }
        if (right === undefined) {
          return 1 * direction
        }
        return left < right ? -1 * direction : 1 * direction
      })
    }

    if (typeof this._limit === 'number') {
      results = results.slice(0, this._limit)
    }

    const docs = results.map(entry => new MockQueryDocumentSnapshot(this._db, `${this._path}/${entry.id}`, entry.data))
    return new MockQuerySnapshot(docs)
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

  where(field, opStr, value) {
    return new MockQuery(this._db, this._path, [{ field, opStr, value }], [])
  }

  orderBy(field, direction = 'asc') {
    return new MockQuery(this._db, this._path, [], [{ field, direction }])
  }

  async get() {
    return new MockQuery(this._db, this._path).get()
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

  set(ref, data, options = {}) {
    const existing = this._writes.get(ref.path) || this._db.getRaw(ref.path)
    if (options && options.merge) {
      this._writes.set(ref.path, applyMerge(existing || {}, data))
    } else {
      this._writes.set(ref.path, applyMerge({}, data))
    }
  }

  update(ref, data) {
    const existing = this._writes.get(ref.path) || this._db.getRaw(ref.path)
    if (!existing) {
      throw new Error('Document does not exist')
    }
    this._writes.set(ref.path, applyMerge(existing, data))
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

  deleteRaw(path) {
    this._store.delete(path)
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
