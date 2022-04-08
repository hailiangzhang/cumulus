import { models } from '@cumulus/api';
import * as S3 from '@cumulus/aws-client/S3';
import { envUtils } from '@cumulus/common';
import Logger from '@cumulus/logger';
import {
  AsyncOperationPgModel,
  CollectionPgModel,
  getKnexClient,
  ProviderPgModel,
  RulePgModel,
} from '@cumulus/db';

import {
  countPostgresRecords,
  generateAggregateReportObj,
  getDynamoTableEntries,
} from './utils';

import { 
  ReportObject,
  CollectionReportObject,
} from './types';

const logger = new Logger({
  sender: '@cumulus/lambdas/postgres-migration-count-tool',
});

/**
* Reconciliation Handler -- generates counts comparing dynamo/es with a postgres
* database
* @param {Object} event - Lambda event
* @param {string} event.systemBucket = process.env.SYSTEM_BUCKET - Cumulus
* deployment's system bucket
* @param {string} event.stackName = process.env.DEPLOYMENT - Cumulus
* deployment's DEPLOYMENT
* @param {number} [event.dbConcurrency = 20] - Max number of concurrent queries
* when generating collection reports
* @param {number} [event.dbMaxPool=20] - Max size of Knex db connection pool
* @param {string} [event.reportBucket] - Bucket to write count report output to
* @param {string} [event.reportPath] - Path to output count report to
* @param {number} [event.cutoffSeconds = 3600] - Number of seconds in the past
* to count backward from. This allows you to explicitly set a window relative to
* the execution of this tool to avoid 'leading edge' ingest processes that may
* not have completed/populated elasticsearch/etc.
* @returns {Promise<reportObj>} -- Returns a reportObj containing the report
* outputs from the run
*/
export const handler = async (
  event: {
    dbConcurrency?: number,
    dbMaxPool?: number,
    reportBucket?: string,
    reportPath?: string,
    cutoffSeconds?: number,
    systemBucket?: string,
    stackName?: string,
    // Arguments below are for unit test injection
    countPostgresRecordsFunction?: typeof countPostgresRecords,
    getDynamoTableEntriesFunction?: typeof getDynamoTableEntries,
    getKnexClientFunction?: typeof getKnexClient,
  }
): Promise<any> => {
  const {
    dbMaxPool = 20,
    reportBucket,
    reportPath,
    cutoffSeconds = 3600,
    systemBucket = envUtils.getRequiredEnvVar('systemBucket'),
    stackName = envUtils.getRequiredEnvVar('prefix'),
    getKnexClientFunction = getKnexClient,
    countPostgresRecordsFunction = countPostgresRecords,
    getDynamoTableEntriesFunction = getDynamoTableEntries,
  } = event;
  process.env.dbMaxPool = `${dbMaxPool}`;

  logger.debug(`Running reconciliation with ${JSON.stringify(event)}`);
  const knexClient = await getKnexClientFunction({ env: process.env });
  const cutoffTime = Date.now() - cutoffSeconds * 1000;
  const cutoffIsoString = new Date(cutoffTime).toISOString();

  const dynamoProvidersModel = new models.Provider();
  const dynamoRulesModel = new models.Rule();

  const dynamoAsyncOperationsModel = new models.AsyncOperation({
    stackName,
    systemBucket,
  });

  const postgresAsyncOperationModel = new AsyncOperationPgModel();
  const postgresCollectionModel = new CollectionPgModel();
  const postgresProviderModel = new ProviderPgModel();
  const postgresRulesModel = new RulePgModel();

  const [
    dynamoProviders,
    dynamoRules,
    dynamoAsyncOperations,
  ] = await getDynamoTableEntriesFunction({
    dynamoProvidersModel,
    dynamoRulesModel,
    dynamoAsyncOperationsModel,
  });
  const dynamoAsyncOperationsCount = dynamoAsyncOperations.length;
  const dynamoCollectionsCount = 0;
  const dynamoProvidersCount = dynamoProviders.length;
  const dynamoRuleCount = dynamoRules.length;

  // Get postgres table counts
  const postgresProviderCount = await countPostgresRecordsFunction({
    model: postgresProviderModel,
    knexClient,
    cutoffIsoString,
  });
  const postgresRulesCount = await countPostgresRecordsFunction({
    model: postgresRulesModel,
    knexClient,
    cutoffIsoString,
  });
  const postgresAsyncOperationsCount = await countPostgresRecordsFunction({
    model: postgresAsyncOperationModel,
    knexClient,
    cutoffIsoString,
  });

  const postgresCollectionCount = await countPostgresRecordsFunction({
    model: postgresCollectionModel,
    knexClient,
    cutoffIsoString,
  });
  // Reformat stats objects to user-readable data
  const CollectionReportObject = {} as CollectionReportObject;
  const aggregateReportObj = generateAggregateReportObj({
    dynamoAsyncOperationsCount,
    dynamoCollectionsCount,
    dynamoProvidersCount,
    dynamoRuleCount,
    postgresAsyncOperationsCount,
    postgresCollectionCount,
    postgresProviderCount,
    postgresRulesCount,
  });
 const collectionFailures = [] as PromiseRejectedResult[];
  // Create output report
  const reportObj = {
    collectionsNotMapped: collectionFailures,
    records_in_dynamo_not_in_postgres: aggregateReportObj,
    pdr_granule_and_execution_records_not_in_postgres_by_collection: CollectionReportObject,
  } as ReportObject;

  // Output results
  logger.info(`Records found in dynamo not found in postgres: ${JSON.stringify(aggregateReportObj)}`);
  if (Object.keys(CollectionReportObject)) {
    logger.error('Collection discrepancies found!');
    logger.error('Details::');
    logger.error(JSON.stringify(CollectionReportObject));
  }

  // Write report object to S3
  if (reportBucket && reportPath) {
    const s3Path = `${S3.s3Join(reportPath)}/reconcileReport-${cutoffTime}`;
    logger.info(`Writing report to ${reportBucket}/${s3Path}`);
    reportObj.s3Uri = `s3://${reportBucket}/${s3Path}`;
    await S3.putJsonS3Object(
      reportBucket,
      s3Path,
      reportObj
    );
  }
  logger.info('Execution complete');
  return reportObj;
};
