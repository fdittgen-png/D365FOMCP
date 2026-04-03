/**
 * Tests for D365FO Task Recorder Parser (taskrecorder-parser.js)
 *
 * Uses real + synthetic .axtr fixtures to verify the parser produces
 * correct Markdown output across all node types and edge cases.
 *
 * Run: npm test                 (all tests)
 *      npm run test:taskrecorder (task recorder tests only)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { parseTaskRecording } from '../src/azure/taskrecorder-parser.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'test.axtr');

// ── Helper: build a minimal .axtr ZIP from XML strings ──────────────────────

function buildAxtr(recordingXml, resourceXml, bpmZipBuffer) {
  const zip = new AdmZip();
  zip.addFile('Recording.xml', Buffer.from(recordingXml, 'utf8'));
  if (resourceXml) {
    zip.addFile('recording_resource.xml', Buffer.from(resourceXml, 'utf8'));
  }
  if (bpmZipBuffer) {
    zip.addFile('BPMPackage.ax7bpm', bpmZipBuffer);
  }
  return zip.toBuffer();
}

function buildBpmZip(processStepXml) {
  const zip = new AdmZip();
  zip.addFile('Recording/ProcessStep.xml', Buffer.from(processStepXml, 'utf8'));
  return zip.toBuffer();
}

// Wrap a list of <Node> elements in a minimal Recording.xml
function wrapRecording(name, nodesXml, formContextsXml = '') {
  return `<?xml version="1.0" encoding="utf-8"?>
<Recording xmlns:i="http://www.w3.org/2001/XMLSchema-instance"
           xmlns="http://schemas.datacontract.org/2004/07/Microsoft.Dynamics.Client.ServerForm.TaskRecording">
  <CanonicalId>test-id-0000</CanonicalId>
  <CurrentSequence>99</CurrentSequence>
  <Description>Test description</Description>
  <FormContexts xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">${formContextsXml}</FormContexts>
  <Name>${name}</Name>
  <RootScope xmlns:z="http://schemas.microsoft.com/2003/10/Serialization/">
    <CustomDescription i:nil="true" />
    <Description i:nil="true" />
    <Id>root-id</Id>
    <Parent i:nil="true" />
    <ParentSequence>0</ParentSequence>
    <ScreenshotUri i:nil="true" />
    <Sequence>0</Sequence>
    <Children>${nodesXml}</Children>
    <IsForm>false</IsForm>
    <IsStepGroup>false</IsStepGroup>
    <Name>${name}</Name>
    <ScopeType>Public</ScopeType>
  </RootScope>
  <Version>1</Version>
</Recording>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. REAL FIXTURE TESTS (test.axtr)
// ══════════════════════════════════════════════════════════════════════════════

describe('parseTaskRecording', () => {

  describe('real .axtr fixture', () => {
    let markdown;

    before(() => {
      const buffer = readFileSync(FIXTURE_PATH);
      markdown = parseTaskRecording(buffer, 'test.axtr');
    });

    it('returns non-empty markdown', () => {
      assert.ok(markdown, 'should return non-empty string');
      assert.ok(markdown.length > 100, 'should return substantial content');
    });

    it('includes all required sections', () => {
      for (const section of ['# Task Recording:', '## Overview', '## Forms Visited', '## Recorded Steps', '## Scope Tree']) {
        assert.ok(markdown.includes(section), `missing section: ${section}`);
      }
    });

    it('extracts recording metadata', () => {
      assert.match(markdown, /# Task Recording: test/);
      assert.match(markdown, /bbb26ccc-f9b5-465b-8eaa-6823eba991a9/);
      assert.match(markdown, /\*\*Version\*\* \| 1/);
    });

    it('reports correct action count and breakdown', () => {
      assert.match(markdown, /\*\*Total User Actions\*\* \| 2/);
      assert.match(markdown, /\*\*Breakdown\*\* \| 2 command/);
    });

    it('extracts form context with menu item details', () => {
      assert.ok(markdown.includes('ElectronicMessagesForm'));
      assert.ok(markdown.includes('Electronic messages'));
      assert.ok(markdown.includes('`ElectronicMessages`'));
      assert.ok(markdown.includes('Display'));
    });

    it('renders CommandUserAction steps correctly', () => {
      assert.ok(markdown.includes('### Step 1'));
      assert.ok(markdown.includes('### Step 2'));
      assert.ok(markdown.includes('Command (ExecuteHyperlink)'));
      assert.ok(markdown.includes('Command (MarkActiveRow)'));
      assert.ok(markdown.includes('Message status'));
      assert.ok(markdown.includes('`[ElectronicMessagesGrid_MessageStatus_StatusId]`'));
    });

    it('renders list context for grid actions', () => {
      assert.ok(markdown.includes('**List/Grid Context:** ElectronicMessagesGrid'));
    });

    it('extracts BPM data sources', () => {
      assert.ok(markdown.includes('## Data Sources'));
      for (const table of ['ElectronicMessageProcessing', 'ElectronicMessages', 'EMMessagesAdditionalFields']) {
        assert.ok(markdown.includes(table), `missing table: ${table}`);
      }
    });

    it('extracts and deduplicates BPM security roles', () => {
      assert.ok(markdown.includes('## Security Roles'));
      assert.ok(markdown.includes('LedgerAccountant'));
      assert.ok(markdown.includes('ElectronicMessageView'));
      assert.ok(markdown.includes('Full control'));
      assert.ok(markdown.includes('View'));
    });

    it('generates scope tree with form and private tags', () => {
      assert.ok(markdown.includes('[Form]'));
      assert.ok(markdown.includes('(Private)'));
      assert.ok(markdown.includes('> ExecuteHyperlink on Message status'));
      assert.ok(markdown.includes('> MarkActiveRow on Overview'));
    });

    it('extracts localized language', () => {
      assert.match(markdown, /\*\*Language\*\* \| en-us/);
    });

    it('includes footer with filename and date', () => {
      assert.ok(markdown.includes('test.axtr'));
      assert.match(markdown, /Generated from/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. PROPERTY/INPUT USER ACTION
  // ══════════════════════════════════════════════════════════════════════════

  describe('PropertyUserAction rendering', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('PropertyTest', `
        <Node i:type="PropertyUserAction">
          <Description>Enter vendor account</Description>
          <Sequence>1</Sequence>
          <Id>p1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-prop-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <ControlLabel>Vendor account</ControlLabel>
          <ControlLabelId i:nil="true" />
          <ControlName>VendAccount</ControlName>
          <ControlType>Input</ControlType>
          <FormId i:nil="true" />
          <LabelId i:nil="true" />
          <PropertyName>Text</PropertyName>
          <Value>US-001</Value>
          <ValueLabel>Contoso</ValueLabel>
          <UserActionType>Input</UserActionType>
          <IsReference>false</IsReference>
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'prop.axtr');
    });

    it('renders set value action', () => {
      assert.ok(markdown.includes('**Action:** Set value'));
    });

    it('shows control and property', () => {
      assert.ok(markdown.includes('Vendor account'));
      assert.ok(markdown.includes('`[VendAccount]`'));
      assert.ok(markdown.includes('**Property:** Text'));
    });

    it('displays value with label', () => {
      assert.ok(markdown.includes('Contoso (`US-001`)'));
    });

    it('includes data entry summary table', () => {
      assert.ok(markdown.includes('## Data Entry Summary'));
      assert.ok(markdown.includes('| Vendor account |'));
      assert.ok(markdown.includes('| Input |'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. INPUT USER ACTION (normalized to PropertyUserAction)
  // ══════════════════════════════════════════════════════════════════════════

  describe('InputUserAction normalization', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('InputTest', `
        <Node i:type="InputUserAction">
          <Description>Enter amount</Description>
          <Sequence>1</Sequence>
          <Id>i1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-input-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <ControlLabel>Amount</ControlLabel>
          <ControlLabelId i:nil="true" />
          <ControlName>AmountField</ControlName>
          <ControlType>Input</ControlType>
          <FormId i:nil="true" />
          <LabelId i:nil="true" />
          <PropertyName>Text</PropertyName>
          <Value>100.00</Value>
          <ValueLabel i:nil="true" />
          <UserActionType>0</UserActionType>
          <IsReference>false</IsReference>
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'input.axtr');
    });

    it('treats InputUserAction as PropertyUserAction', () => {
      assert.ok(markdown.includes('**Action:** Set value'));
      assert.ok(markdown.includes('`100`'));  // fast-xml-parser parses "100.00" as number 100
    });

    it('normalizes UserActionType 0 to Input', () => {
      assert.ok(markdown.includes('| Input |'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. INFO USER ACTION
  // ══════════════════════════════════════════════════════════════════════════

  describe('InfoUserAction rendering', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('InfoTest', `
        <Node i:type="InfoUserAction">
          <Description>Info step desc</Description>
          <Sequence>1</Sequence>
          <Id>info1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-info-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <ControlLabel>StatusBar</ControlLabel>
          <ControlLabelId i:nil="true" />
          <ControlName>InfoCtrl</ControlName>
          <ControlType>Static</ControlType>
          <FormId i:nil="true" />
          <LabelId i:nil="true" />
          <Text>Record was saved successfully</Text>
          <Notes>Check the status bar</Notes>
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'info.axtr');
    });

    it('renders info action', () => {
      assert.ok(markdown.includes('**Info:** Record was saved successfully'));
      assert.ok(markdown.includes('**Action:** Informational note'));
    });

    it('shows notes', () => {
      assert.ok(markdown.includes('**Notes:** Check the status bar'));
    });

    it('shows control', () => {
      assert.ok(markdown.includes('StatusBar'));
      assert.ok(markdown.includes('`[InfoCtrl]`'));
    });

    it('counts as info in breakdown', () => {
      assert.ok(markdown.includes('1 info'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. VALIDATION USER ACTION
  // ══════════════════════════════════════════════════════════════════════════

  describe('ValidationUserAction rendering', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('ValTest', `
        <Node i:type="ValidationUserAction">
          <Description>Verify total is correct</Description>
          <Sequence>1</Sequence>
          <Id>v1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-val-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <Name>TotalValidation</Name>
          <Comment>Should equal 500.00</Comment>
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'val.axtr');
    });

    it('renders validation action', () => {
      assert.ok(markdown.includes('**Validate:**'));
      assert.ok(markdown.includes('**Action:** Validation assertion'));
    });

    it('shows validation name and comment', () => {
      assert.ok(markdown.includes('**Validation:** TotalValidation'));
      assert.ok(markdown.includes('**Comment:** Should equal 500.00'));
    });

    it('includes validations summary section', () => {
      assert.ok(markdown.includes('## Validations'));
      assert.ok(markdown.includes('**TotalValidation** - Should equal 500.00'));
    });

    it('counts as validation in breakdown', () => {
      assert.ok(markdown.includes('1 validation'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. TASK USER ACTION (subtasks)
  // ══════════════════════════════════════════════════════════════════════════

  describe('TaskUserAction rendering', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('TaskTest', `
        <Node i:type="TaskUserAction">
          <Description>Begin create PO</Description>
          <Sequence>1</Sequence>
          <Id>t1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-task-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <Name>Create purchase order</Name>
          <Comment>Standard PO flow</Comment>
          <UserActionType>Begin</UserActionType>
        </Node>
        <Node i:type="TaskUserAction">
          <Description>End create PO</Description>
          <Sequence>2</Sequence>
          <Id>t2</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-task-2</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <Name>Create purchase order</Name>
          <Comment i:nil="true" />
          <UserActionType>End</UserActionType>
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'task.axtr');
    });

    it('renders BEGIN subtask marker', () => {
      assert.ok(markdown.includes('Subtask BEGIN: Create purchase order'));
      assert.ok(markdown.includes('Subtask marker (BEGIN)'));
    });

    it('renders END subtask marker', () => {
      assert.ok(markdown.includes('Subtask END: Create purchase order'));
      assert.ok(markdown.includes('Subtask marker (END)'));
    });

    it('shows comment on begin task', () => {
      assert.ok(markdown.includes('**Comment:** Standard PO flow'));
    });

    it('includes subtasks summary section', () => {
      assert.ok(markdown.includes('## Subtasks'));
      assert.ok(markdown.includes('**Create purchase order** - Standard PO flow'));
    });

    it('counts as subtask marker in breakdown', () => {
      assert.ok(markdown.includes('2 subtask marker'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. MENU ITEM USER ACTION
  // ══════════════════════════════════════════════════════════════════════════

  describe('MenuItemUserAction rendering', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('MenuTest', `
        <Node i:type="MenuItemUserAction">
          <Description>Open vendor list</Description>
          <Sequence>1</Sequence>
          <Id>m1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-menu-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <MenuItemName>VendTableListPage</MenuItemName>
          <MenuItemType>Display</MenuItemType>
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'menu.axtr');
    });

    it('renders navigate action', () => {
      assert.ok(markdown.includes('**Navigate:** Open vendor list'));
      assert.ok(markdown.includes('**Action:** Open menu item'));
    });

    it('shows menu item details', () => {
      assert.ok(markdown.includes('`VendTableListPage`'));
      assert.ok(markdown.includes('Display'));
    });

    it('counts as navigation in breakdown', () => {
      assert.ok(markdown.includes('1 navigation'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. ANNOTATION USER ACTION
  // ══════════════════════════════════════════════════════════════════════════

  describe('AnnotationUserAction rendering', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('AnnotTest', `
        <Node i:type="AnnotationUserAction">
          <Description>User added a note here</Description>
          <Sequence>1</Sequence>
          <Id>a1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-annot-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'annot.axtr');
    });

    it('renders annotation action', () => {
      assert.ok(markdown.includes('**Action:** Annotation edit'));
      assert.ok(markdown.includes('User added a note here'));
    });

    it('counts as annotation in breakdown', () => {
      assert.ok(markdown.includes('1 annotation'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. SYSTEM-GENERATED FLAG
  // ══════════════════════════════════════════════════════════════════════════

  describe('system-generated flag', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('SysGenTest', `
        <Node i:type="CommandUserAction">
          <Description>System step</Description>
          <Sequence>1</Sequence>
          <Id>sg1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-sg-1</GlobalId>
          <SystemGenerated>true</SystemGenerated>
          <ControlLabel>Btn</ControlLabel>
          <ControlLabelId i:nil="true" />
          <ControlName>BtnCtrl</ControlName>
          <ControlType>Button</ControlType>
          <FormId i:nil="true" />
          <LabelId i:nil="true" />
          <CommandName>Click</CommandName>
          <ListContext i:nil="true" />
          <RowIndex i:nil="true" />
          <Arguments />
          <ReturnType>Void</ReturnType>
          <ReturnValue i:nil="true" />
          <TaskId i:nil="true" />
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'sysgen.axtr');
    });

    it('tags system-generated steps', () => {
      assert.ok(markdown.includes('`[system-generated]`'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 10. CUSTOM DESCRIPTION OVERRIDE
  // ══════════════════════════════════════════════════════════════════════════

  describe('custom description', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('CustomDescTest', `
        <Node i:type="CommandUserAction">
          <Description>Original description</Description>
          <Sequence>1</Sequence>
          <Id>cd1</Id>
          <CustomDescription>My custom step text</CustomDescription>
          <ScreenshotUri i:nil="true" />
          <GlobalId>guid-cd-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <ControlLabel>Btn</ControlLabel>
          <ControlLabelId i:nil="true" />
          <ControlName>BtnCtrl</ControlName>
          <ControlType>Button</ControlType>
          <FormId i:nil="true" />
          <LabelId i:nil="true" />
          <CommandName>Click</CommandName>
          <ListContext i:nil="true" />
          <RowIndex i:nil="true" />
          <Arguments />
          <ReturnType>Void</ReturnType>
          <ReturnValue i:nil="true" />
          <TaskId i:nil="true" />
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'custom.axtr');
    });

    it('uses custom description over original', () => {
      assert.ok(markdown.includes('My custom step text'));
      assert.ok(!markdown.includes('> **Original description**'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 11. SCREENSHOT URI
  // ══════════════════════════════════════════════════════════════════════════

  describe('screenshot URI', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('ScreenshotTest', `
        <Node i:type="CommandUserAction">
          <Description>Step with screenshot</Description>
          <Sequence>1</Sequence>
          <Id>ss1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri>https://storage.blob.core/screenshots/step1.png</ScreenshotUri>
          <GlobalId>guid-ss-1</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <ControlLabel>Btn</ControlLabel>
          <ControlLabelId i:nil="true" />
          <ControlName>BtnCtrl</ControlName>
          <ControlType>Button</ControlType>
          <FormId i:nil="true" />
          <LabelId i:nil="true" />
          <CommandName>Click</CommandName>
          <ListContext i:nil="true" />
          <RowIndex i:nil="true" />
          <Arguments />
          <ReturnType>Void</ReturnType>
          <ReturnValue i:nil="true" />
          <TaskId i:nil="true" />
        </Node>
      `);
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'screenshot.axtr');
    });

    it('renders screenshot link', () => {
      assert.ok(markdown.includes('**Screenshot:** https://storage.blob.core/screenshots/step1.png'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 12. EMPTY RECORDING (no actions)
  // ══════════════════════════════════════════════════════════════════════════

  describe('empty recording', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('EmptyRecording', '');
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'empty.axtr');
    });

    it('shows zero actions', () => {
      assert.match(markdown, /\*\*Total User Actions\*\* \| 0/);
    });

    it('shows no actions message', () => {
      assert.ok(markdown.includes('*(no user actions recorded)*'));
    });

    it('shows no forms message', () => {
      assert.ok(markdown.includes('*(no form contexts recorded)*'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 13. RECORDING DESCRIPTION
  // ══════════════════════════════════════════════════════════════════════════

  describe('recording with description', () => {
    let markdown;

    before(() => {
      const xml = wrapRecording('DescTest', '');
      const buffer = buildAxtr(xml);
      markdown = parseTaskRecording(buffer, 'desc.axtr');
    });

    it('renders description', () => {
      assert.ok(markdown.includes('Test description'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 14. LOCALIZED STEP DESCRIPTIONS
  // ══════════════════════════════════════════════════════════════════════════

  describe('localized step descriptions', () => {
    let markdown;

    before(() => {
      const recXml = wrapRecording('LocalizedTest', `
        <Node i:type="CommandUserAction">
          <Description>Original EN desc</Description>
          <Sequence>1</Sequence>
          <Id>loc1</Id>
          <CustomDescription i:nil="true" />
          <ScreenshotUri i:nil="true" />
          <GlobalId>my-global-id</GlobalId>
          <SystemGenerated>false</SystemGenerated>
          <ControlLabel>Btn</ControlLabel>
          <ControlLabelId i:nil="true" />
          <ControlName>BtnCtrl</ControlName>
          <ControlType>Button</ControlType>
          <FormId i:nil="true" />
          <LabelId i:nil="true" />
          <CommandName>Click</CommandName>
          <ListContext i:nil="true" />
          <RowIndex i:nil="true" />
          <Arguments />
          <ReturnType>Void</ReturnType>
          <ReturnValue i:nil="true" />
          <TaskId i:nil="true" />
        </Node>
      `);
      const resXml = `<?xml version="1.0" encoding="utf-8"?>
<xsd lang="de-de">
  <step_description _locId="my-global-id/StepDescription">Lokalisierte Beschreibung</step_description>
</xsd>`;
      const buffer = buildAxtr(recXml, resXml);
      markdown = parseTaskRecording(buffer, 'localized.axtr');
    });

    it('uses localized description over original', () => {
      assert.ok(markdown.includes('Lokalisierte Beschreibung'));
      assert.ok(!markdown.includes('> **Original EN desc**'));
    });

    it('extracts language', () => {
      assert.ok(markdown.includes('de-de'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 15. BPM PACKAGE WITH LABELS
  // ══════════════════════════════════════════════════════════════════════════

  describe('BPM package parsing', () => {
    let markdown;

    before(() => {
      const recXml = wrapRecording('BpmTest', '');
      const bpmXml = `<?xml version="1.0" encoding="utf-8"?>
<Activities>
  <Task Id="1" AOTName="VendTable" Type="MenuItemDisplay" Layer="sys" Model="AppSuite">
    <Labels LabelId="Vendors">
      <Label Label="Vendors" help="Open vendor list page" />
    </Labels>
    <FormDataSource>
      <DataSource>VendTable</DataSource>
      <DataSource>DirPartyTable</DataSource>
    </FormDataSource>
    <Permissions>
      <Security RoleName="VendPaymentClerk" RoleDisplayName="AP clerk"
                DutyName="VendPaymentMaintain" DutyDisplayName="Maintain payments"
                PrivilegeName="VendPaymentView" PrivilegeDisplayName="View payments"
                AccessLevel="View" />
    </Permissions>
  </Task>
</Activities>`;
      const bpmBuffer = buildBpmZip(bpmXml);
      const buffer = buildAxtr(recXml, null, bpmBuffer);
      markdown = parseTaskRecording(buffer, 'bpm.axtr');
    });

    it('extracts data sources', () => {
      assert.ok(markdown.includes('`VendTable`'));
      assert.ok(markdown.includes('`DirPartyTable`'));
    });

    it('extracts security roles', () => {
      assert.ok(markdown.includes('AP clerk'));
      assert.ok(markdown.includes('VendPaymentClerk'));
      assert.ok(markdown.includes('View payments'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 16. ERROR HANDLING
  // ══════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('throws on non-ZIP buffer', () => {
      assert.throws(
        () => parseTaskRecording(Buffer.from('not a zip'), 'bad.axtr'),
        /Invalid|not a valid|Bad/i
      );
    });

    it('throws on empty buffer', () => {
      assert.throws(() => parseTaskRecording(Buffer.alloc(0), 'empty.axtr'));
    });

    it('throws when Recording.xml is missing', () => {
      const zip = new AdmZip();
      zip.addFile('other.xml', Buffer.from('<root/>'));
      assert.throws(
        () => parseTaskRecording(zip.toBuffer(), 'no-recording.axtr'),
        /Recording\.xml not found/
      );
    });

    it('throws when RootScope is missing', () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Recording xmlns="http://schemas.datacontract.org/2004/07/Microsoft.Dynamics.Client.ServerForm.TaskRecording">
  <Name>broken</Name>
  <Version>1</Version>
</Recording>`;
      const zip = new AdmZip();
      zip.addFile('Recording.xml', Buffer.from(xml));
      assert.throws(
        () => parseTaskRecording(zip.toBuffer(), 'no-rootscope.axtr'),
        /RootScope not found/
      );
    });

    it('handles corrupt BPM package gracefully', () => {
      const recXml = wrapRecording('CorruptBpm', '');
      const zip = new AdmZip();
      zip.addFile('Recording.xml', Buffer.from(recXml));
      zip.addFile('BPMPackage.ax7bpm', Buffer.from('corrupt data'));
      const md = parseTaskRecording(zip.toBuffer(), 'corrupt-bpm.axtr');
      assert.ok(md.includes('# Task Recording: CorruptBpm'));
    });

    it('handles corrupt recording_resource.xml gracefully', () => {
      const recXml = wrapRecording('CorruptRes', '');
      const buffer = buildAxtr(recXml, 'not xml at all {{{{');
      const md = parseTaskRecording(buffer, 'corrupt-res.axtr');
      assert.ok(md.includes('# Task Recording: CorruptRes'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 17. FILENAME PARAMETER
  // ══════════════════════════════════════════════════════════════════════════

  describe('filename parameter', () => {
    it('uses provided filename in footer', () => {
      const buffer = readFileSync(FIXTURE_PATH);
      const md = parseTaskRecording(buffer, 'custom-name.axtr');
      assert.ok(md.includes('custom-name.axtr'));
    });

    it('defaults filename when omitted', () => {
      const buffer = readFileSync(FIXTURE_PATH);
      const md = parseTaskRecording(buffer);
      assert.ok(md.includes('recording.axtr'));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 18. TOOL REGISTRATION (taskrecorder-tools.js)
  // ══════════════════════════════════════════════════════════════════════════

  describe('registerTaskRecorderTools', () => {
    let toolHandlers;

    before(async () => {
      const { registerTaskRecorderTools } = await import('../src/azure/taskrecorder-tools.js');
      toolHandlers = {};
      const mockServer = {
        tool: (name, _desc, schema, handler) => { toolHandlers[name] = { schema, handler }; },
      };
      registerTaskRecorderTools(mockServer);
    });

    it('registers the taskrecorder_to_markdown tool', () => {
      assert.ok(toolHandlers['taskrecorder_to_markdown'], 'tool should be registered');
    });

    it('parses valid base64 .axtr content', async () => {
      const buffer = readFileSync(FIXTURE_PATH);
      const base64 = buffer.toString('base64');
      const result = await toolHandlers['taskrecorder_to_markdown'].handler({
        file_content: base64,
        file_name: 'test.axtr',
      });
      const text = result.content[0].text;
      assert.ok(text.includes('# Task Recording: test'));
      assert.ok(text.includes('## Recorded Steps'));
    });

    it('returns error for invalid base64', async () => {
      const result = await toolHandlers['taskrecorder_to_markdown'].handler({
        file_content: 'bm90YXppcA==',  // "notazip" in base64
        file_name: 'bad.axtr',
      });
      const text = result.content[0].text;
      assert.ok(text.includes('Error'));
    });
  });
});
