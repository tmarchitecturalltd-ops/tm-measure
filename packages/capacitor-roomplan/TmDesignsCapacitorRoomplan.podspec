require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'TmDesignsCapacitorRoomplan'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => 'Proprietary', :text => 'Copyright TM Architectural Designs Ltd.' }
  s.homepage = 'https://tm-architectural.co.uk'
  s.author = { 'TM Architectural Designs' => 'inquiries@tmdesignsltd.com' }
  s.source = { :git => 'https://tm-architectural.co.uk/capacitor-roomplan.git', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_versions = ['5.1']
  # RoomPlan is only linked at runtime behind #if canImport(RoomPlan) +
  # #available(iOS 16.0, *), so we can keep the pod's deployment target
  # at 14.0 without preventing RoomPlan symbols from resolving on newer
  # devices.
  s.weak_frameworks = ['RoomPlan']
end
