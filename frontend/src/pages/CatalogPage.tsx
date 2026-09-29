import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Multiselect from '@cloudscape-design/components/multiselect';
import Pagination from '@cloudscape-design/components/pagination';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import type { CatalogModel, CatalogResponse, InferenceProfile } from '../api/types';
import { useApp } from '../state/AppContext';
import { useAsync } from '../state/useAsync';

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v && v.trim() !== ''))).sort();
}

/**
 * Native Bedrock model catalog. A catalog hit is a candidate, not evidence of
 * equivalence — the page says so rather than implying availability.
 */
export function CatalogPage({ region, embedded = false, selection }: {
  region?: string;
  embedded?: boolean;
  selection?: {
    modelId: string;
    profileId?: string;
    onModel: (model: CatalogModel) => void;
    onRoute: (profile: InferenceProfile | null, region: string) => void;
    onCompare: () => void;
  };
} = {}) {
  const { client } = useApp();
  const catalog = useAsync<CatalogResponse>(
    (signal) => client.catalogModels(signal, region),
    [client, region]
  );

  const [filterText, setFilterText] = useState('');
  const [pageIndex, setPageIndex] = useState(1);
  const [providers, setProviders] = useState<readonly string[]>([]);
  const [modalities, setModalities] = useState<readonly string[]>([]);

  const models = catalog.data?.models ?? [];
  const chosen = models.find((m) => m.modelId === selection?.modelId);
  const routes = (catalog.data?.inferenceProfiles ?? [])
    .filter((profile) => profile.modelIds.includes(selection?.modelId ?? '') && profile.status === 'ACTIVE');
  const routeOptions = [
    ...(chosen?.inferenceTypes.includes('ON_DEMAND') ? [{
      value: 'regional', label: `Only ${catalog.data?.region}`,
      description: 'Requests are processed in this Region.',
    }] : []),
    ...routes.map((profile) => ({
      value: profile.id, label: profile.name,
      description: profile.global
        ? 'Worldwide processing. Global pricing and residency policies are not supported in this release.'
        : `Allow processing in ${profile.processingRegions.join(', ')}.`,
      disabled: profile.global || !profile.processingRegions.length,
    })),
  ];
  const selectedRoute = routeOptions.find((option) => option.value === (
    selection?.profileId || (chosen?.inferenceTypes.includes('ON_DEMAND') ? 'regional' : '')
  )) ?? null;

  const providerOptions = useMemo(
    () => uniqueSorted(models.map((m) => m.provider)).map((v) => ({ label: v, value: v })),
    [models]
  );

  const modalityOptions = useMemo(
    () =>
      uniqueSorted(
        models.flatMap((m) => [...m.inputModalities, ...m.outputModalities])
      ).map((v) => ({ label: v, value: v })),
    [models]
  );

  const filtered = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return models.filter((model) => {
      if (providers.length > 0 && !providers.includes(model.provider)) {
        return false;
      }
      if (modalities.length > 0) {
        const modelModalities = [
          ...model.inputModalities,
          ...model.outputModalities,
        ];
        if (!modalities.some((m) => modelModalities.includes(m))) return false;
      }
      if (needle === '') return true;
      return (
        model.modelId.toLowerCase().includes(needle) ||
        model.modelName.toLowerCase().includes(needle) ||
        model.provider.toLowerCase().includes(needle)
      );
    });
  }, [models, filterText, providers, modalities]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const visiblePage = Math.min(pageIndex, pageCount);
  useEffect(() => setPageIndex(1), [filterText, providers, modalities, region]);

  const filtersActive =
    filterText.trim() !== '' || providers.length > 0 || modalities.length > 0;

  const clearFilters = () => {
    setFilterText('');
    setProviders([]);
    setModalities([]);
  };

  return (
    <ContentLayout
      header={
        <Header
          variant={embedded ? "h3" : "h1"}
          description="Models listed by Amazon Bedrock in the selected location. A listing does not confirm your account has access or that a model meets your application’s needs."
          actions={
            <Button
              iconName="refresh"
              onClick={catalog.reload}
              loading={catalog.loading}
              ariaLabel="Reload the model catalog"
            >
              Reload
            </Button>
          }
        >
          Model catalog
        </Header>
      }
    >
      <SpaceBetween size="l">
        {selection ? <Box variant="small">You can select models that accept and generate text. Other modalities are available to browse; this comparison does not price them yet.</Box> : null}
        {selection?.modelId ? (
          <Container header={<Header variant="h3">Selected Bedrock model</Header>}>
            <SpaceBetween size="m">
              <Box fontWeight="bold">{chosen?.modelName ?? selection.modelId}</Box>
              <Box variant="small">{selection.modelId}</Box>
              <FormField label="Where may Bedrock process these requests?"
                description="Some models use an inference profile to route requests across Regions. Choosing a route allows its listed processing Regions for this project.">
                <Select
                  ariaLabel="Bedrock request route"
                  selectedOption={selectedRoute}
                  options={routeOptions}
                  statusType={catalog.loading ? 'loading' : 'finished'}
                  placeholder="Choose an allowed processing location"
                  empty="No supported on-demand routes were found for this model."
                  onChange={({ detail }) => {
                    const profile = routes.find((p) => p.id === detail.selectedOption.value) ?? null;
                    if (!profile && detail.selectedOption.value !== 'regional') return;
                    selection.onRoute(profile, catalog.data?.region ?? region ?? 'us-east-1');
                  }}
                />
              </FormField>
              {selectedRoute ? <Box variant="small">{selectedRoute.description}</Box> : null}
              {chosen && !chosen.inferenceTypes.some((type) => type === 'ON_DEMAND' || type === 'INFERENCE_PROFILE') ? (
                <StatusIndicator type="info">This catalog entry requires provisioned throughput. Its pricing is not supported in this comparison. Choose an on-demand entry if one is available.</StatusIndicator>
              ) : null}
              {catalog.data?.profileIssue ? <StatusIndicator type="warning">{catalog.data.profileIssue}</StatusIndicator> : null}
              <Box variant="small" color="text-body-secondary">
                Compare Standard text input and output costs. No model files, GPU or import are needed.
                Account access and performance are checked separately.
              </Box>
              <Button onClick={selection.onCompare} variant="primary" disabled={!selectedRoute || catalog.loading}>
                Compare hosting for this model
              </Button>
            </SpaceBetween>
          </Container>
        ) : null}
        {catalog.error ? (
          <Alert
            type="error"
            statusIconAriaLabel="Error"
            header="Could not load the model catalog"
            action={
              <Button onClick={catalog.reload} iconName="refresh">
                Retry
              </Button>
            }
          >
            {catalog.error.message}
          </Alert>
        ) : null}

        {catalog.data?.note && !embedded ? (
          <Alert type="info" statusIconAriaLabel="Information" header="Catalog note">
            {catalog.data.note}
          </Alert>
        ) : null}

        <Table<CatalogModel>
          loading={catalog.loading}
          loadingText="Loading the native Bedrock model catalog"
          items={filtered.slice((visiblePage - 1) * 10, visiblePage * 10)}
          pagination={<Pagination
            currentPageIndex={visiblePage}
            pagesCount={pageCount}
            onChange={({ detail }) => setPageIndex(detail.currentPageIndex)}
            ariaLabels={{ nextPageLabel: 'Next page of models', previousPageLabel: 'Previous page of models', pageLabel: (number) => `Page ${number}` }}
          />}
          trackBy="modelId"
          variant="container"
          wrapLines
          resizableColumns
          ariaLabels={{ tableLabel: 'Native Bedrock models' }}
          header={
            <Header
              variant="h2"
              counter={
                catalog.data
                  ? filtersActive
                    ? `(${filtered.length}/${models.length})`
                    : `(${models.length})`
                  : undefined
              }
              description={
                catalog.data
                  ? `Region ${catalog.data.region}. The backend reported ${catalog.data.count} models.`
                  : undefined
              }
            >
              Models
            </Header>
          }
          filter={
            <SpaceBetween size="xs">
              <TextFilter
                filteringText={filterText}
                filteringPlaceholder="Find a model by ID, name or provider"
                filteringAriaLabel="Filter models"
                onChange={({ detail }) => setFilterText(detail.filteringText)}
                countText={
                  filtersActive ? `${filtered.length} matches` : undefined
                }
              />
              <SpaceBetween direction="horizontal" size="xs">
                <Multiselect
                  selectedOptions={providers.map((v) => ({ label: v, value: v }))}
                  options={providerOptions}
                  onChange={({ detail }) =>
                    setProviders(
                      detail.selectedOptions
                        .map((o) => o.value)
                        .filter((v): v is string => Boolean(v))
                    )
                  }
                  placeholder="Filter by provider"
                  ariaLabel="Filter by provider"
                  empty="No providers in the loaded catalog"
                  disabled={providerOptions.length === 0}
                />
                <Multiselect
                  selectedOptions={modalities.map((v) => ({ label: v, value: v }))}
                  options={modalityOptions}
                  onChange={({ detail }) =>
                    setModalities(
                      detail.selectedOptions
                        .map((o) => o.value)
                        .filter((v): v is string => Boolean(v))
                    )
                  }
                  placeholder="Filter by modality"
                  ariaLabel="Filter by modality"
                  empty="No modalities in the loaded catalog"
                  disabled={modalityOptions.length === 0}
                />
                {filtersActive ? (
                  <Button onClick={clearFilters}>Clear filters</Button>
                ) : null}
              </SpaceBetween>
            </SpaceBetween>
          }
          columnDefinitions={[
            ...(selection ? [{
              id: 'select', header: 'Choose',
              cell: (item: CatalogModel) => (
                <Button
                  ariaLabel={`Use ${item.modelName || item.modelId}`}
                  disabled={!item.inputModalities.includes('TEXT') || !item.outputModalities.includes('TEXT')}
                  iconName={item.modelId === selection.modelId ? 'check' : undefined}
                  onClick={() => selection.onModel(item)}
                >
                  {item.modelId === selection.modelId ? 'Selected' : 'Use this model'}
                </Button>
              ),
            }] : []),
            {
              id: 'modelName',
              header: 'Model',
              sortingField: 'modelName',
              cell: (item) => (
                <SpaceBetween size="xxxs">
                  <Box variant="span" fontWeight="bold">
                    {item.modelName || item.modelId}
                  </Box>
                  <Box variant="small" color="text-body-secondary">
                    {item.modelId}
                  </Box>
                </SpaceBetween>
              ),
            },
            {
              id: 'provider',
              header: 'Provider',
              sortingField: 'provider',
              cell: (item) => item.provider || 'Not reported',
            },
            {
              id: 'input',
              header: 'Input modalities',
              cell: (item) =>
                item.inputModalities.length === 0
                  ? 'Not reported'
                  : item.inputModalities.join(', '),
            },
            {
              id: 'output',
              header: 'Output modalities',
              cell: (item) =>
                item.outputModalities.length === 0
                  ? 'Not reported'
                  : item.outputModalities.join(', '),
            },
            {
              id: 'streaming',
              header: 'Streaming',
              cell: (item) =>
                item.streamingSupported ? (
                  <StatusIndicator type="success">Supported</StatusIndicator>
                ) : (
                  <StatusIndicator type="stopped">Not supported</StatusIndicator>
                ),
            },
            {
              id: 'inferenceTypes',
              header: 'How it is offered',
              cell: (item) =>
                item.inferenceTypes.length === 0 ? (
                  'Not reported'
                ) : (
                  <SpaceBetween direction="horizontal" size="xxs">
                    {item.inferenceTypes.map((type) => (
                      <Badge key={type}>{({
                        ON_DEMAND: 'On demand',
                        PROVISIONED: 'Provisioned throughput',
                        INFERENCE_PROFILE: 'Request routing profile',
                      } as Record<string, string>)[type] ?? type}</Badge>
                    ))}
                  </SpaceBetween>
                ),
            },
          ]}
          empty={
            /*
             * Cloudscape's Table exposes a single `empty` slot, so the empty
             * and no-match states are distinguished here: filters active with
             * models loaded means the filters excluded everything, which needs
             * a reset affordance rather than an "empty catalog" message.
             */
            filtersActive && models.length > 0 ? (
              <Box textAlign="center" color="inherit" padding={{ vertical: 'l' }}>
                <SpaceBetween size="xs">
                  <b>No matches</b>
                  <Box variant="p" color="text-body-secondary">
                    {models.length} models were loaded; the current provider,
                    modality and text filters excluded all of them.
                  </Box>
                  <Button onClick={clearFilters}>Clear filters</Button>
                </SpaceBetween>
              </Box>
            ) : (
              <Box textAlign="center" color="inherit" padding={{ vertical: 'l' }}>
                <SpaceBetween size="xs">
                  <b>
                    {catalog.settled && models.length === 0
                      ? 'No models returned'
                      : 'No models'}
                  </b>
                  <Box variant="p" color="text-body-secondary">
                    {catalog.settled && models.length === 0
                      ? 'The backend returned an empty catalog for this region. Nothing is invented to fill the table.'
                      : 'Waiting for the catalog.'}
                  </Box>
                </SpaceBetween>
              </Box>
            )
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
}

export default CatalogPage;
