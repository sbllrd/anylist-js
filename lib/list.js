const FormData = require('form-data');
const Item = require('./item');
const uuid = require('./uuid');

/**
 * List class.
 * @class
 *
 * @param {object} list list
 * @param {object} context context
 *
 * @property {string} identifier
 * @property {string} parentId
 * @property {string} name
 * @property {Item[]} items
 */
class List {
	/**
   * @hideconstructor
   */
	constructor(list, {client, protobuf, uid, stores}) {
		this.identifier = list.identifier;
		this.parentId = list.listId;
		this.name = list.name;

		this.items = list.items.map(i => new Item(i, {client, protobuf, uid}));
		this.categoryGroups = [];
		this.stores = stores || [];
		this.client = client;
		this.protobuf = protobuf;
		this.uid = uid;
	}

	/**
   * Internal: populate this list's category groups from the
   * PBListCategoryGroupResponse[] returned by user-data/get.
   * Called by AnyList.getLists() after construction.
   */
	_setCategoryGroups(groupResponses) {
		this.categoryGroups = (groupResponses || [])
			.filter(r => r.categoryGroup)
			.map(r => ({
				identifier: r.categoryGroup.identifier,
				name: r.categoryGroup.name,
				listId: r.categoryGroup.listId,
				defaultCategoryId: r.categoryGroup.defaultCategoryId,
				categories: (r.categoryGroup.categories || []).map(c => ({
					identifier: c.identifier,
					name: c.name,
					icon: c.icon,
					systemCategory: c.systemCategory,
					sortIndex: typeof c.sortIndex === 'number' ? c.sortIndex : 0,
					categoryGroupId: c.categoryGroupId,
				})),
			}));
	}

	/**
   * Adds an item to this list.
   * Will also save item to local
   * copy of list.
   * Must set `isFavorite=true` if editing "favorites" list
   * @param {Item} item to add
   * @param {boolean} [isFavorite=false]
   * @return {Promise<Item>} saved item
   */
	async addItem(item, isFavorite = false) {
		if (item.constructor !== Item) {
			throw new TypeError('Must be an instance of the Item class.');
		}

		item.listId = this.identifier;

		const op = new this.protobuf.PBListOperation();

		op.setMetadata({
			operationId: uuid(),
			handlerId: isFavorite ? 'add-item' : 'add-shopping-list-item',
			userId: this.uid,
		});

		op.setListId(this.identifier);
		op.setListItemId(item.identifier);
		op.setListItem(item._encode());

		const ops = new this.protobuf.PBListOperationList();

		ops.setOperations([op]);

		const form = new FormData();

		form.append('operations', ops.toBuffer());
		await this.client.post(isFavorite ? 'data/starter-lists/update' : 'data/shopping-lists/update', {
			body: form,
		});

		this.items.push(item);

		return item;
	}

	/**
   * Uncheck all items in a list
   * @return {Promise}
   */

	async uncheckAll() {
		const op = new this.protobuf.PBListOperation();

		op.setMetadata({
			operationId: uuid(),
			handlerId: 'uncheck-all',
			userId: this.uid,
		});

		op.setListId(this.identifier);
		const ops = new this.protobuf.PBListOperationList();
		ops.setOperations([op]);
		const form = new FormData();
		form.append('operations', ops.toBuffer());
		await this.client.post('data/shopping-lists/update', {
			body: form,
		});
	}

	/**
   * Remove an item from this list.
   * Will also remove item from local
   * copy of list.
   * Must set `isFavorite=true` if editing "favorites" list
   * @param {Item} item to remove
   * @param {boolean} [isFavorite=false]
   * @return {Promise}
   */
	async removeItem(item, isFavorite = false) {
		const op = new this.protobuf.PBListOperation();

		op.setMetadata({
			operationId: uuid(),
			handlerId: isFavorite ? 'remove-item' : 'remove-shopping-list-item',
			userId: this.uid,
		});

		op.setListId(this.identifier);
		op.setListItemId(item.identifier);
		op.setListItem(item._encode());

		const ops = new this.protobuf.PBListOperationList();

		ops.setOperations([op]);

		const form = new FormData();

		form.append('operations', ops.toBuffer());

		await this.client.post(isFavorite ? 'data/starter-lists/update' : 'data/shopping-lists/update', {
			body: form,
		});

		this.items = this.items.filter(i => i.identifier !== item.identifier);
	}

	/**
   * Get Item from List by identifier.
   * @param {string} identifier item ID
   * @return {Item} found Item
   */
	getItemById(identifier) {
		return this.items.find(i => i.identifier === identifier);
	}

	/**
   * Get Item from List by name.
   * @param {string} name item name
   * @return {Item} found Item
   */
	getItemByName(name) {
		return this.items.find(i => i.name === name);
	}

	/**
   * Get category group by identifier.
   * @param {string} groupId
   * @return {object|undefined}
   */
	getCategoryGroupById(groupId) {
		return this.categoryGroups.find(g => g.identifier === groupId);
	}

	/**
   * Find a category by id across all groups in this list.
   * @param {string} categoryId
   * @return {{group: object, category: object}|null}
   */
	findCategory(categoryId) {
		for (const group of this.categoryGroups) {
			const category = group.categories.find(c => c.identifier === categoryId);
			if (category) {
				return {group, category};
			}
		}

		return null;
	}

	/**
   * Find a category by case-insensitive, whitespace-tolerant name across all
   * groups in this list. Returns the first match. AnyList allows category
   * names with leading/trailing whitespace, which is an easy lookup trap.
   * @param {string} name
   * @return {{group: object, category: object}|null}
   */
	findCategoryByName(name) {
		const target = String(name || '').trim().toLowerCase();
		for (const group of this.categoryGroups) {
			const category = group.categories.find(
				c => (c.name || '').trim().toLowerCase() === target
			);
			if (category) {
				return {group, category};
			}
		}

		return null;
	}

	/**
   * Create a new category group on this list. Last-resort fallback for
   * createCategory when the list genuinely has zero groups after a fresh
   * getLists() — AnyList's server actually auto-provisions a default group
   * on list creation (observed live as an "Untitled Category Set" holding
   * just "Other"), so this should rarely fire; the real fix for a
   * just-created list having no *locally cached* groups is AnyList#createList
   * re-fetching getLists() before returning. A group created by this method
   * is NOT automatically made the list's active category set (that's
   * PBListSettings.listCategoryGroupId, set separately, unimplemented) —
   * items assigned to a category in it may still display as "Other" in the
   * app. Parallel to createCategory, but for PBListCategoryGroup /
   * ListCategoryGroupOperation instead of PBListCategory / ListCategoryOperation.
   * Unverified against a live account: the handler ID ('create-category-group')
   * and operation class (4, ListCategoryGroupOperation, inferred from the
   * OperationClass enum) are both guesses — nothing in phildenhoff/anylist_rs
   * creates a category group either, so there was no reference implementation
   * to copy.
   * @param {string} name name for the group
   * @return {Promise<object>} the created group (local copy)
   */
	async createCategoryGroup(name) {
		const cleanName = String(name || '').trim() || 'Categories';
		const groupId = uuid();

		const group = new this.protobuf.PBListCategoryGroup({
			identifier: groupId,
			logicalTimestamp: 1,
			listId: this.identifier,
			name: cleanName,
		});

		const op = new this.protobuf.PBListOperation();
		op.setMetadata({
			operationId: uuid(),
			handlerId: 'create-category-group',
			userId: this.uid,
			operationClass: 4, // ListCategoryGroupOperation
		});
		op.setListId(this.identifier);
		op.setUpdatedCategoryGroup(group);

		await this._postCategoryOps([op]);

		const localGroup = {
			identifier: groupId,
			name: cleanName,
			listId: this.identifier,
			defaultCategoryId: null,
			categories: [],
		};
		this.categoryGroups.push(localGroup);

		return localGroup;
	}

	/**
   * Create a new custom category in this list.
   * If categoryGroupId is omitted, the list's only / first group is used,
   * creating one first (via createCategoryGroup) if the list has none yet.
   * @param {object} options
   * @param {string} options.name
   * @param {string} [options.categoryGroupId]
   * @param {string} [options.icon]
   * @param {number} [options.sortIndex=0]
   * @return {Promise<object>} the created category (local copy)
   */
	async createCategory({name, categoryGroupId, icon, sortIndex = 0}) {
		const cleanName = String(name || '').trim();
		if (!cleanName) {
			throw new Error('Category name is required.');
		}

		let group = categoryGroupId
			? this.getCategoryGroupById(categoryGroupId)
			: this.categoryGroups[0];
		if (!group && categoryGroupId) {
			throw new Error(`Category group "${categoryGroupId}" not found in list "${this.name}".`);
		}

		if (!group) {
			group = await this.createCategoryGroup('Categories');
		}

		const newCategoryId = uuid();
		const categoryFields = {
			identifier: newCategoryId,
			logicalTimestamp: 1,
			categoryGroupId: group.identifier,
			listId: this.identifier,
			name: cleanName,
			sortIndex,
		};
		if (icon) {
			categoryFields.icon = icon;
		}

		const category = new this.protobuf.PBListCategory(categoryFields);

		const op = new this.protobuf.PBListOperation();
		op.setMetadata({
			operationId: uuid(),
			handlerId: 'create-category',
			userId: this.uid,
			operationClass: 3, // ListCategoryOperation
		});
		op.setListId(this.identifier);
		op.setUpdatedCategory(category);

		await this._postCategoryOps([op]);

		const localCategory = {
			identifier: newCategoryId,
			name: cleanName,
			icon: icon || null,
			systemCategory: null,
			sortIndex,
			categoryGroupId: group.identifier,
		};
		group.categories.push(localCategory);

		return localCategory;
	}

	/**
   * Rename a custom category by id.
   * @param {string} categoryId
   * @param {string} newName
   * @return {Promise<object>} the updated category (local copy)
   */
	async renameCategory(categoryId, newName) {
		const cleanNewName = String(newName || '').trim();
		if (!cleanNewName) {
			throw new Error('New category name is required.');
		}

		const found = this.findCategory(categoryId);
		if (!found) {
			throw new Error(`Category "${categoryId}" not found in list "${this.name}".`);
		}

		const {group, category} = found;
		const updatedCategory = new this.protobuf.PBListCategory({
			identifier: category.identifier,
			logicalTimestamp: 1,
			categoryGroupId: group.identifier,
			listId: this.identifier,
			name: cleanNewName,
			sortIndex: category.sortIndex,
			...(category.icon ? {icon: category.icon} : {}),
		});

		const op = new this.protobuf.PBListOperation();
		op.setMetadata({
			operationId: uuid(),
			handlerId: 'set-category-name',
			userId: this.uid,
			operationClass: 3,
		});
		op.setListId(this.identifier);
		op.setUpdatedValue(cleanNewName);
		op.setUpdatedCategory(updatedCategory);

		await this._postCategoryOps([op]);

		category.name = cleanNewName;
		return category;
	}

	/**
   * Remove a custom category by id.
   * @param {string} categoryId
   * @return {Promise}
   */
	async removeCategory(categoryId) {
		const found = this.findCategory(categoryId);
		if (!found) {
			throw new Error(`Category "${categoryId}" not found in list "${this.name}".`);
		}

		const op = new this.protobuf.PBListOperation();
		op.setMetadata({
			operationId: uuid(),
			handlerId: 'remove-category',
			userId: this.uid,
			operationClass: 3,
		});
		op.setListId(this.identifier);
		op.setOriginalValue(categoryId);

		await this._postCategoryOps([op]);

		const {group} = found;
		group.categories = group.categories.filter(c => c.identifier !== categoryId);
	}

	async _postCategoryOps(ops) {
		const opList = new this.protobuf.PBListOperationList();
		opList.setOperations(ops);

		const form = new FormData();
		form.append('operations', opList.toBuffer());

		// Category mutations require the v2 endpoint per the reverse-engineered Rust client (phildenhoff/anylist_rs).
		await this.client.post('data/shopping-lists/update-v2', {
			body: form,
		});
	}
   /**
   * Get a store on this list by name.
   * @param {string} name store name
   * @return {object} found store
   */
	findStoreByName(name) {
		return this.stores.find(s => s.name === name);
	}
}

module.exports = List;
