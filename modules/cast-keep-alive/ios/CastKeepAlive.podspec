Pod::Spec.new do |s|
  s.name           = 'CastKeepAlive'
  s.version        = '1.0.0'
  s.summary        = 'Keeps the file server alive while casting'
  s.description    = 'Foreground service (Android) / background task (iOS) so a local-file cast survives the screen locking.'
  s.author         = 'Jeramai Faber'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
