import * as React from 'react';
import { observer } from 'mobx-react-lite';
import * as styles from './index.module.less';
import { ReactEditorComponent } from '@ali/ide-editor/lib/browser';
import { useInjectable, PreferenceSchemaProvider, PreferenceDataProperty, PreferenceProvider } from '@ali/ide-core-browser';
import { PreferenceService } from './preference.service';
import './index.less';
import { IWorkspaceService } from '@ali/ide-workspace';

let initView = false;
let selectedPreference;
export const PreferenceView: ReactEditorComponent<null> = (props) => {

  const preferenceService: PreferenceService  = useInjectable(PreferenceService);
  const defaultPreferenceProvider: PreferenceSchemaProvider = (preferenceService.defaultPreference as PreferenceSchemaProvider);

  const defaultList = defaultPreferenceProvider.getPreferences();
  const [list, setList] = React.useState({});

  const workspaceService: IWorkspaceService = useInjectable(IWorkspaceService);

  workspaceService.whenReady.finally(() => {
    preferenceService.userPreference.ready.finally(() => {
      if (!initView) {
        initView = true;
        selectedPreference = preferenceService.userPreference;
        preferenceService.getPreferences(preferenceService.userPreference).then((list) => {
          setList(Object.assign({}, defaultList, list));
        });
      }
    });
  });

  const changeValue = (key, value) => {
    selectedPreference.setPreference(key, value).then(() => {
      preferenceService.getPreferences(selectedPreference).then( (list) => {
          setList(Object.assign({}, defaultList, list));
      });
    });
  };

  const renderScopeSelect = () => {
    const options: React.ReactNode[] = [];
    options.push(<option value='user'>User</option>);
    options.push(<option value='workspace'>WorkSpace</option>);

    return (<select
      className='scope-select'
      value={selectedPreference ? selectedPreference.name : 'user'}
      onChange={async (event) => {
        const name = (event.target as HTMLSelectElement).value;
        switch (name) {
          case 'user':
            selectedPreference = preferenceService.userPreference;
            preferenceService.getPreferences(preferenceService.userPreference).then((list) => {
              setList(Object.assign({}, defaultList, list));
            });
            break;
          case 'workspace':
            selectedPreference = preferenceService.workspacePreference;
            preferenceService.getPreferences(preferenceService.workspacePreference).then((list) => {
              setList(Object.assign({}, defaultList, list));
            });
            break;
        }

    }}>{options}</select>);
  };

  const renderPreferenceList = () => {
    const results: React.ReactNode[] = [];

    for (const key of Object.keys(list)) {
      results.push(renderPreferenceItem(key, list[key]));
    }
    return results;
  };

  const renderPreferenceItem = (key, value) => {
    const prop: PreferenceDataProperty|undefined = defaultPreferenceProvider.getPreferenceProperty(key);
    if (prop) {
      switch (prop.type) {
        case 'boolean':
          return renderBooleanValue(key, value);
          break;
        case 'integer':
        case 'number':
          return renderNumberValue(key, value);
          break;
        case 'string':
          if (prop.enum) {
            return renderEnumsValue(key, value);
          } else {
            return renderTextValue(key, value);
          }
          break;
        default:
          return <div></div>;
      }
    }
    return <div></div>;
  };

  const renderBooleanValue = (key, value) => {
    const prop: PreferenceDataProperty|undefined = defaultPreferenceProvider.getPreferenceProperty(key);

    return (
      <div className='preference-line' key={key}>
        <div className='key'>
          {key}
        </div>
        <div className='control-wrap'>
          <select onChange={(event) => {
              changeValue(key, event.target.value === 'true');
            }}
            className='select-control'
            value={value ? 'true' : 'false'}
          >
            <option key='true' value='true'>true</option>
            <option key='value' value='false'>false</option>
          </select>
        </div>
        {prop && prop.description && <div className='desc'>{prop.description}</div>}
      </div>
    );
  };

  const renderNumberValue = (key, value) => {
    const prop: PreferenceDataProperty|undefined = defaultPreferenceProvider.getPreferenceProperty(key);

    return (
      <div className='preference-line' key={key}>
        <div className='key'>
          {key}
        </div>
        {prop && prop.description && <div className='desc'>{prop.description}</div>}
        <div className='control-wrap'>
          <input
            type='number'
            className='number-control'
            onChange={(event) => {
              changeValue(key, parseInt(event.target.value, 10));
            }}
            defaultValue={value}
          />
        </div>
      </div>
    );
  };

  const renderTextValue = (key, value) => {
    const prop: PreferenceDataProperty|undefined = defaultPreferenceProvider.getPreferenceProperty(key);

    return (
      <div className='preference-line' key={key}>
        <div className='key'>
          {key}
        </div>
        {prop && prop.description && <div className='desc'>{prop.description}</div>}
        <div className='control-wrap'>
          <input
            type='text'
            className='text-control'
            onChange={(event) => {
              changeValue(key, event.target.value);
            }}
            defaultValue={value}
          />
        </div>
      </div>
    );
  };

  const renderEnumsValue = (key, value) => {
    const prop: PreferenceDataProperty|undefined = defaultPreferenceProvider.getPreferenceProperty(key);

    if (!prop) {
      return <div></div>;
    }

    const options = (prop as PreferenceDataProperty).enum!.map((item) => {
      return <option value={item}>{item}</option>;
    });

    return (
      <div className='preference-line' key={key}>
        <div className='key'>
          {key}
        </div>
        {prop && prop.description && <div className='desc'>{prop.description}</div>}
        <div className='control-wrap'>
          <select onChange={(event) => {
              changeValue(key, event.target.value);
            }}
            className='select-control'
            defaultValue={value}
          >
            {options}
          </select>
        </div>
      </div>
    );
  };

  return (
    <div className='preference-view'>
      <div>
        {renderScopeSelect()}
      </div>
      <div className='property-list' key={Object.keys(list).join('-')}>
        {renderPreferenceList()}
      </div>
    </div>
  );
};
