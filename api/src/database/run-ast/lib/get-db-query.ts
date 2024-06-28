import { useEnv } from '@directus/env';
import type { Filter, Query, SchemaOverview } from '@directus/types';
import type { Knex } from 'knex';
import { cloneDeep } from 'lodash-es';
import type { FieldNode, FunctionFieldNode, O2MNode } from '../../../types/ast.js';
import type { ColumnSortRecord } from '../../../utils/apply-query.js';
import applyQuery, { applyLimit, applySort, generateAlias } from '../../../utils/apply-query.js';
import { getCollectionFromAlias } from '../../../utils/get-collection-from-alias.js';
import type { AliasMap } from '../../../utils/get-column-path.js';
import { getColumn } from '../../../utils/get-column.js';
import { getHelpers } from '../../helpers/index.js';
import { applyCaseWhen } from '../utils/apply-case-when.js';
import { getColumnPreprocessor } from '../utils/get-column-pre-processor.js';
import { getNodeAlias } from '../utils/get-field-alias.js';
import { getInnerQueryColumnPreProcessor } from '../utils/get-inner-query-column-pre-processor.js';

export function getDBQuery(
	schema: SchemaOverview,
	knex: Knex,
	table: string,
	fieldNodes: (FieldNode | FunctionFieldNode)[],
	o2mNodes: O2MNode[],
	query: Query,
	cases: Filter[],
): Knex.QueryBuilder {
	const aliasMap: AliasMap = Object.create(null);
	const env = useEnv();
	const preProcess = getColumnPreprocessor(knex, schema, table, cases, aliasMap);
	const queryCopy = cloneDeep(query);
	const helpers = getHelpers(knex);

	const hasCaseWhen =
		o2mNodes.some((node) => node.whenCase && node.whenCase.length > 0) ||
		fieldNodes.some((node) => node.whenCase && node.whenCase.length > 0);

	queryCopy.limit = typeof queryCopy.limit === 'number' ? queryCopy.limit : Number(env['QUERY_LIMIT_DEFAULT']);

	// Queries with aggregates and groupBy will not have duplicate result
	if (queryCopy.aggregate || queryCopy.group) {
		const flatQuery = knex.from(table).select(fieldNodes.map((node) => preProcess(node)));
		return applyQuery(knex, table, flatQuery, queryCopy, schema, cases).query;
	}

	const primaryKey = schema.collections[table]!.primary;
	let dbQuery = knex.from(table);
	let sortRecords: ColumnSortRecord[] | undefined;
	const innerQuerySortRecords: { alias: string; order: 'asc' | 'desc' }[] = [];
	let hasMultiRelationalSort: boolean | undefined;

	if (queryCopy.sort) {
		const sortResult = applySort(knex, schema, dbQuery, queryCopy, table, aliasMap, true);

		if (sortResult) {
			sortRecords = sortResult.sortRecords;
			hasMultiRelationalSort = sortResult.hasMultiRelationalSort;
		}
	}

	const { hasMultiRelationalFilter } = applyQuery(knex, table, dbQuery, queryCopy, schema, cases, {
		aliasMap,
		isInnerQuery: true,
		hasMultiRelationalSort,
	});

	const needsInnerQuery = hasMultiRelationalSort || hasMultiRelationalFilter;

	if (needsInnerQuery) {
		dbQuery.select(`${table}.${primaryKey}`);

		// Only add distinct if there are no case/when constructs, since otherwise we rely on group by
		if (!hasCaseWhen) dbQuery.distinct();
	} else {
		dbQuery.select(fieldNodes.map((node) => preProcess(node)));

		// Add flags for o2m fields with case/when to the let the DB to the partial item permissions
		dbQuery.select(
			o2mNodes
				.filter((node) => node.whenCase && node.whenCase.length > 0)
				.map((node) => {
					const columnCases = node.whenCase!.map((index) => cases[index]!);
					return applyCaseWhen(
						{
							column: knex.raw(1),
							columnCases,
							aliasMap,
							cases,
							table,
							alias: node.fieldKey,
						},
						{ knex, schema },
					);
				}),
		);
	}

	if (sortRecords) {
		// Clears the order if any, eg: from MSSQL offset
		dbQuery.clear('order');

		if (needsInnerQuery) {
			let orderByString = '';
			const orderByFields: Knex.Raw[] = [];

			sortRecords.map((sortRecord) => {
				if (orderByString.length !== 0) {
					orderByString += ', ';
				}

				const sortAlias = `sort_${generateAlias()}`;

				if (sortRecord.column.includes('.')) {
					const [alias, field] = sortRecord.column.split('.');
					const originalCollectionName = getCollectionFromAlias(alias!, aliasMap);
					dbQuery.select(getColumn(knex, alias!, field!, sortAlias, schema, { originalCollectionName }));

					orderByString += `?? ${sortRecord.order}`;
					orderByFields.push(getColumn(knex, alias!, field!, false, schema, { originalCollectionName }));
				} else {
					dbQuery.select(getColumn(knex, table, sortRecord.column, sortAlias, schema));

					orderByString += `?? ${sortRecord.order}`;
					orderByFields.push(getColumn(knex, table, sortRecord.column, false, schema));
				}

				innerQuerySortRecords.push({ alias: sortAlias, order: sortRecord.order });
			});

			dbQuery.orderByRaw(orderByString, orderByFields);

			if (hasMultiRelationalSort) {
				dbQuery = helpers.schema.applyMultiRelationalSort(
					knex,
					dbQuery,
					table,
					primaryKey,
					orderByString,
					orderByFields,
				);
			}
		} else {
			sortRecords.map((sortRecord) => {
				if (sortRecord.column.includes('.')) {
					const [alias, field] = sortRecord.column.split('.');

					sortRecord.column = getColumn(knex, alias!, field!, false, schema, {
						originalCollectionName: getCollectionFromAlias(alias!, aliasMap),
					}) as any;
				} else {
					sortRecord.column = getColumn(knex, table, sortRecord.column, false, schema) as any;
				}
			});

			dbQuery.orderBy(sortRecords);
		}
	}

	if (!needsInnerQuery) return dbQuery;

	const innerCaseWhenAliasPrefix = generateAlias();

	if (hasCaseWhen) {
		/* If there are cases, we need to employ a trick in order to evaluate the case/when structure in the inner query,
		   while passing the result of the evaluation to the outer query. The case/when needs to be evaluated in the inner
		   query since only there all joined in tables, that might be required for the case/when, are available.

		   The problem is, that the resulting columns can not be directly selected in the inner query,
		   as a `SELECT DISTINCT` does not work for all datatypes in all vendors.

		   So instead of having an inner query which might look like this:

		   SELECT DISTINCT ...,
		     CASE WHEN <condition> THEN <actual-column> END AS <alias>

			 Another problem is that all not all rows with the same primary key are guaranteed to have the same value for
			 the columns with the case/when, so we to `or` those together, but counting the number of flags in a group by
			 operation. This way the flag is set to > 0 if any of the rows in the group allows access to the column.

		   The inner query only evaluates the condition and passes up or-ed flag, that is used in the wrapper query to select
		   the actual column:

		   SELECT ...,
		     COUNT (CASE WHEN <condition> THEN 1 END) AS <random-prefix>_<alias>
		     ...
		     GROUP BY <primary-key>

		    Then, in the wrapper query there is no need to evaluate the condition again, but instead rely on the flag:

		    SELECT ...,
		      CASE WHEN `inner`.<random-prefix>_<alias> > 0 THEN <actual-column> END AS <alias>
		 */

		const innerPreprocess = getInnerQueryColumnPreProcessor(
			knex,
			schema,
			table,
			cases,
			aliasMap,
			innerCaseWhenAliasPrefix,
		);

		// To optimize the query we avoid having unnecessary columns in the inner query, that don't have a caseWhen, since
		// they are selected in the outer query directly
		dbQuery.select(fieldNodes.map(innerPreprocess).filter((x) => x !== null));

		// In addition to the regular columns select a flag that indicates if a user has access to o2m related field
		// based on the case/when of that field.
		dbQuery.select(o2mNodes.map(innerPreprocess).filter((x) => x !== null));

		const groupByFields = [knex.raw('??.??', [table, primaryKey])];

		if (hasMultiRelationalSort) {
			// Sort fields that are not directly in the table the primary key is from need to be included in the group
			// by clause, otherwise this causes problems on some DBs
			groupByFields.push(...innerQuerySortRecords.map(({ alias }) => knex.raw('??', alias)));
		}

		dbQuery.groupBy(groupByFields);
	}

	const wrapperQuery = knex
		.from(table)
		.innerJoin(knex.raw('??', dbQuery.as('inner')), `${table}.${primaryKey}`, `inner.${primaryKey}`);

	if (!hasCaseWhen) {
		// No need for case/when in the wrapper query, just select the preprocessed columns
		wrapperQuery.select(fieldNodes.map((node) => preProcess(node)));
	} else {
		// This applies a simplified case/when construct in the wrapper query, that only looks at flag > 1

		// Distinguish between column with and without case/when and handle them differently
		const plainColumns = fieldNodes.filter((fieldNode) => !fieldNode.whenCase || fieldNode.whenCase.length === 0);
		const whenCaseColumns = fieldNodes.filter((fieldNode) => fieldNode.whenCase && fieldNode.whenCase.length > 0);

		// Select the plain columns
		wrapperQuery.select(plainColumns.map((node) => preProcess(node)));

		// Select the case/when columns based on the flag from the inner query
		wrapperQuery.select(
			whenCaseColumns.map((fieldNode) => {
				const alias = getNodeAlias(fieldNode);

				const innerAlias = `${innerCaseWhenAliasPrefix}_${alias}`;

				// Preprocess the column without the case/when, since that is applied in a simpler fashion in the select
				const column = preProcess({ ...fieldNode, whenCase: [] }, { noAlias: true });

				return knex.raw(`CASE WHEN ??.?? > 0 THEN ?? END as ??`, ['inner', innerAlias, column, alias]);
			}),
		);

		// Pass the flags of o2m fields up through the wrapper query
		wrapperQuery.select(
			o2mNodes
				.filter((node) => node.whenCase && node.whenCase.length > 0)
				.map((node) => {
					const alias = node.fieldKey;

					const innerAlias = `${innerCaseWhenAliasPrefix}_${alias}`;

					return knex.raw(`CASE WHEN ??.?? > 0 THEN 1 END as ??`, ['inner', innerAlias, alias]);
				}),
		);
	}

	if (sortRecords && needsInnerQuery) {
		innerQuerySortRecords.map((innerQuerySortRecord) => {
			wrapperQuery.orderBy(`inner.${innerQuerySortRecord.alias}`, innerQuerySortRecord.order);
		});

		if (hasMultiRelationalSort) {
			wrapperQuery.where('inner.directus_row_number', '=', 1);
			applyLimit(knex, wrapperQuery, queryCopy.limit);
		}
	}

	return wrapperQuery;
}
